// @author Mathias Bouhon Keulen
// @date 2026-03-20
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as path from 'path';
import {
  LogEntry,
  LogEntryType,
  MessageHandler,
  NetworkError,
  NodeId,
  RPCMessage,
  Transport,
} from '@maboke123/raft-core';
import fs from 'fs/promises';

/**
 * Normalized AppendEntries response shape used for protobuf conversion helpers.
 */
type AppendEntriesResponseLike = {
  term: number;
  success: boolean;
  matchIndex?: number;
  conflictIndex?: number;
  conflictTerm?: number;
};

type RpcEnvelope<T extends RPCMessage['type'], D extends RPCMessage['direction']> = Extract<
  RPCMessage,
  { type: T; direction: D }
>;
type RequestVoteRequestPayload = RpcEnvelope<'RequestVote', 'request'>['payload'];
type RequestVoteResponsePayload = RpcEnvelope<'RequestVote', 'response'>['payload'];
type AppendEntriesRequestPayload = RpcEnvelope<'AppendEntries', 'request'>['payload'];
type InstallSnapshotRequestPayload = RpcEnvelope<'InstallSnapshot', 'request'>['payload'];
type InstallSnapshotResponsePayload = RpcEnvelope<'InstallSnapshot', 'response'>['payload'];

type GrpcAppendEntriesRequestPayload = Omit<AppendEntriesRequestPayload, 'entries'> & { entries: object[] };
type GrpcInstallSnapshotRequestPayload = Omit<InstallSnapshotRequestPayload, 'config'> & { config: string };

type GrpcOutboundMessage =
  | { method: 'RequestVote'; payload: RequestVoteRequestPayload }
  | { method: 'AppendEntries'; payload: GrpcAppendEntriesRequestPayload }
  | { method: 'InstallSnapshot'; payload: GrpcInstallSnapshotRequestPayload };

type RawAppendEntriesResponse = {
  term: number;
  success: boolean;
  hasMatchIndex?: boolean;
  matchIndex?: number;
  hasConflictIndex?: boolean;
  conflictIndex?: number;
  hasConflictTerm?: boolean;
  conflictTerm?: number;
};

type RawInstallSnapshotResponse = {
  term: number;
  success: boolean;
};

type GrpcClientCallback = (err: grpc.ServiceError | null, response: unknown) => void;

interface GrpcRaftClient {
  close(): void;
  RequestVote(
    payload: RequestVoteRequestPayload,
    metadata: grpc.Metadata,
    options: { deadline: Date },
    callback: GrpcClientCallback,
  ): void;
  AppendEntries(
    payload: GrpcAppendEntriesRequestPayload,
    metadata: grpc.Metadata,
    options: { deadline: Date },
    callback: GrpcClientCallback,
  ): void;
  InstallSnapshot(
    payload: GrpcInstallSnapshotRequestPayload,
    metadata: grpc.Metadata,
    options: { deadline: Date },
    callback: GrpcClientCallback,
  ): void;
}

type GrpcTransportService = {
  service: grpc.ServiceDefinition<grpc.UntypedServiceImplementation>;
  new (address: string, credentials: grpc.ChannelCredentials, options?: grpc.ChannelOptions): GrpcRaftClient;
};

type LoadedGrpcProto = {
  raft: {
    RaftService: GrpcTransportService;
  };
};

type CallWithMetadata<TRequest> = {
  request: TRequest;
  metadata: grpc.Metadata;
};

type GrpcRequestVoteCall = CallWithMetadata<RequestVoteRequestPayload>;
type GrpcAppendEntriesCall = CallWithMetadata<Omit<AppendEntriesRequestPayload, 'entries'> & { entries?: unknown[] }>;
type GrpcInstallSnapshotCall = CallWithMetadata<
  Omit<InstallSnapshotRequestPayload, 'data' | 'config'> & { data: Buffer | Uint8Array; config?: string }
>;

type GrpcServiceCallback<T> = (err: grpc.ServiceError | null, value?: T) => void;

function toRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new NetworkError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function toNumber(value: unknown, label: string): number {
  if (typeof value !== 'number') {
    console.log(value);
    console.log(value);
    console.log(value);
    console.log(value);
    console.log(value);
    console.log(value);
    console.log(value);
    throw new NetworkError(`${label} must be a number`);
  }
  return value;
}

function toBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new NetworkError(`${label} must be a boolean, but was ${typeof value}`);
  }
  return value;
}

function toStringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new NetworkError(`${label} must be a string`);
  }
  return value;
}

function toLogEntryType(value: unknown, label: string): LogEntryType {
  if (
    value === LogEntryType.CONFIG ||
    value === LogEntryType.NOOP ||
    value === LogEntryType.COMMAND ||
    value === LogEntryType.DROPLOG
  ) {
    return value;
  }
  throw new NetworkError(`${label} must be a valid log entry type`);
}

function makeServiceError(code: grpc.status, message: string): grpc.ServiceError {
  const err = new Error(message) as grpc.ServiceError;
  err.code = code;
  err.details = message;
  err.metadata = new grpc.Metadata();
  return err;
}

const protoPath = path.resolve(__dirname, '../proto/raft.proto');

/**
 * Converts raft-core log entries to protobuf-compatible plain objects.
 *
 * @param entry Log entry to serialize.
 * @returns Serializable object for gRPC payload encoding.
 */
function serializeLogEntry(entry: LogEntry): object {
  if (entry.type === LogEntryType.CONFIG) {
    return {
      term: entry.term,
      index: entry.index,
      type: entry.type,
      config: JSON.stringify(entry.config),
    };
  }

  if (entry.type === LogEntryType.NOOP) {
    return {
      term: entry.term,
      index: entry.index,
      type: entry.type,
    };
  }

  if (entry.type === LogEntryType.COMMAND) {
    return {
      term: entry.term,
      index: entry.index,
      type: entry.type,
      command: {
        type: entry.command!.type,
        payload: Buffer.from(JSON.stringify(entry.command!.payload)),
      },
    };
  }

  if (entry.type === LogEntryType.DROPLOG) {
    return {
      term: entry.term,
      index: entry.index,
      type: entry.type,
      startIdx: entry.startIdx,
      finalIdx: entry.finalIdx,
    };
  }

  throw new Error(`Invalid LogEntryType in serialization`);
}

/**
 * Converts protobuf log entry objects to raft-core log entries.
 *
 * @param raw Raw protobuf entry payload.
 * @returns Deserialized raft-core log entry.
 */
function deserializeLogEntry(raw: unknown): LogEntry {
  const rawObj = toRecord(raw, 'log entry');
  const type = toLogEntryType(rawObj.type, 'log entry.type');

  if (type === LogEntryType.CONFIG) {
    const config: unknown = typeof rawObj.config === 'string' ? JSON.parse(rawObj.config) : rawObj.config;
    return {
      term: toNumber(rawObj.term, 'log entry.term'),
      index: toNumber(rawObj.index, 'log entry.index'),
      type: LogEntryType.CONFIG,
      config: config as LogEntry['config'],
    };
  }

  if (type === LogEntryType.NOOP) {
    return {
      term: toNumber(rawObj.term, 'log entry.term'),
      index: toNumber(rawObj.index, 'log entry.index'),
      type: LogEntryType.NOOP,
    };
  }

  if (type === LogEntryType.COMMAND) {
    const command = toRecord(rawObj.command, 'log entry.command');
    const payloadSource = command.payload;
    const payloadText = Buffer.isBuffer(payloadSource)
      ? payloadSource.toString()
      : toStringValue(payloadSource, 'log entry.command.payload');
    const payload = JSON.parse(payloadText) as unknown;

    return {
      term: toNumber(rawObj.term, 'log entry.term'),
      index: toNumber(rawObj.index, 'log entry.index'),
      type: LogEntryType.COMMAND,
      command: {
        type: toStringValue(command.type, 'log entry.command.type'),
        payload,
      },
    };
  }

  if (type === LogEntryType.DROPLOG) {
    return {
      term: toNumber(rawObj.term, 'log entry.term'),
      index: toNumber(rawObj.index, 'log entry.index'),
      type: LogEntryType.DROPLOG,
      startIdx: toNumber(rawObj.startIdx, 'log entry.startIdx'),
      finalIdx: toNumber(rawObj.finalIdx, 'log entry.finalIdx'),
    };
  }

  throw new Error(`Error in deserialization of log entry`);
}

const packageDefinition = protoLoader.loadSync(protoPath, {
  keepCase: true,
  longs: Number,
  enums: String,
  defaults: false,
  oneofs: true,
});

const proto = grpc.loadPackageDefinition(packageDefinition) as unknown as LoadedGrpcProto;

/**
 * Maps an outbound raft-core RPC request message to gRPC method and payload.
 *
 * @param message Outbound raft-core request envelope.
 * @returns Target gRPC method and payload object.
 * @throws NetworkError When message type/direction is not supported.
 */
export function rpcMessageToGrpc(message: RPCMessage): GrpcOutboundMessage {
  if (message.type === 'RequestVote' && message.direction === 'request') {
    return {
      method: 'RequestVote',
      payload: message.payload,
    };
  } else if (message.type === 'AppendEntries' && message.direction === 'request') {
    // console.log("EEEE", message, message.payload.entries)

    return {
      method: 'AppendEntries',
      payload: {
        ...message.payload,
        entries: message.payload.entries.map((entry) => serializeLogEntry(entry)),
      },
    };
  } else if (message.type === 'InstallSnapshot' && message.direction === 'request') {
    return {
      method: 'InstallSnapshot',
      payload: {
        ...message.payload,
        data: message.payload.data,
        config: JSON.stringify(message.payload.config),
      },
    };
  }
  throw new NetworkError(`Unsupported message type or direction: ${message.type} ${message.direction}`);
}

/**
 * Maps a gRPC method response payload to raft-core RPC response message.
 *
 * @param method gRPC method name.
 * @param raw Raw response payload.
 * @returns raft-core RPC response envelope.
 * @throws NetworkError When method is not supported.
 */
export function grpcToRpcMessage(method: string, raw: unknown): RPCMessage {
  const rawObj = toRecord(raw, `gRPC ${method} response`);

  if (method === 'RequestVote') {
    const payload: RequestVoteResponsePayload = {
      term: toNumber(rawObj.term, 'RequestVote.term'),
      voteGranted: toBoolean(rawObj.voteGranted, 'RequestVote.voteGranted'),
    };

    return {
      type: 'RequestVote',
      direction: 'response',
      payload,
    };
  } else if (method === 'AppendEntries') {
    const appendRaw = rawObj as RawAppendEntriesResponse;

    const payload: AppendEntriesResponseLike = {
      term: toNumber(appendRaw.term, 'AppendEntries.term'),
      success: toBoolean(appendRaw.success, 'AppendEntries.success'),
      ...(appendRaw.hasMatchIndex === true && typeof appendRaw.matchIndex === 'number'
        ? { matchIndex: appendRaw.matchIndex }
        : {}),
      ...(appendRaw.hasConflictIndex === true && typeof appendRaw.conflictIndex === 'number'
        ? { conflictIndex: appendRaw.conflictIndex }
        : {}),
      ...(appendRaw.hasConflictTerm === true && typeof appendRaw.conflictTerm === 'number'
        ? { conflictTerm: appendRaw.conflictTerm }
        : {}),
    };

    return {
      type: 'AppendEntries',
      direction: 'response',
      payload: payload,
    };
  } else if (method === 'InstallSnapshot') {
    const installRaw = rawObj as RawInstallSnapshotResponse;
    const payload: InstallSnapshotResponsePayload = {
      term: toNumber(installRaw.term, 'InstallSnapshot.term'),
      success: toBoolean(installRaw.success, 'InstallSnapshot.success'),
    };
    return {
      type: 'InstallSnapshot',
      direction: 'response',
      payload,
    };
  }

  throw new NetworkError(`Unsupported gRPC method: ${method}`);
}

/**
 * Serializes optional AppendEntries conflict/match fields for protobuf transport.
 *
 * @param response AppendEntries response payload.
 * @returns Protobuf-friendly response object with explicit presence flags.
 */
export function serializeAppendEntriesResponse(response: AppendEntriesResponseLike): object {
  return {
    term: response.term,
    success: response.success,
    hasMatchIndex: response.matchIndex !== undefined,
    matchIndex: response.matchIndex ?? 0,
    hasConflictIndex: response.conflictIndex !== undefined,
    conflictIndex: response.conflictIndex ?? 0,
    hasConflictTerm: response.conflictTerm !== undefined,
    conflictTerm: response.conflictTerm ?? 0,
  };
}

/**
 * gRPC transport implementation for raft-core `Transport` interface.
 *
 * @remarks
 * Handles client/server lifecycle, request/response conversion between protobuf
 * payloads and raft-core RPC messages, peer management, and timeout/deadline wiring.
 */
export class GrpcTransport implements Transport {
  private handler: MessageHandler | null = null;
  private started: boolean = false;
  private server: grpc.Server | null = null;
  private clients: Map<NodeId, GrpcRaftClient> = new Map();

  private readonly callTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly maxGrpcMessageBytes: number;

  private cachedClientsCredentials: grpc.ChannelCredentials | null = null;

  constructor(
    private readonly nodeId: NodeId,
    private readonly port: number,
    private readonly peers: Record<NodeId, string>,
    private readonly certPaths?: {
      caCert: string;
      nodeCert: string;
      nodeKey: string;
    },
    callTimeoutMs: number = 5000,
    shutdownTimeoutMs: number = 5000,
    maxGrpcMessageBytes: number = 16 * 1024 * 1024,
  ) {
    this.callTimeoutMs = callTimeoutMs;
    this.shutdownTimeoutMs = shutdownTimeoutMs;
    this.maxGrpcMessageBytes = maxGrpcMessageBytes;
  }

  /**
   * Starts gRPC server, loads TLS credentials when configured, and initializes peer clients.
   *
   * @throws NetworkError When transport is already started or bind fails.
   */
  async start(): Promise<void> {
    if (this.started) {
      throw new NetworkError(`Transport for node ${this.nodeId} is already started.`);
    }

    const grpcOptions = {
      'grpc.enable_retries': 0,
      'grpc.max_receive_message_length': this.maxGrpcMessageBytes,
      'grpc.max_send_message_length': this.maxGrpcMessageBytes,
    };

    this.server = new grpc.Server(grpcOptions);
    this.server.addService(proto.raft.RaftService.service, this.buildServiceImplementation());

    let serverCredentials: grpc.ServerCredentials;
    let clientCredentials: grpc.ChannelCredentials;

    if (this.certPaths) {
      const caCert = await fs.readFile(this.certPaths.caCert);
      const nodeCert = await fs.readFile(this.certPaths.nodeCert);
      const nodeKey = await fs.readFile(this.certPaths.nodeKey);

      serverCredentials = grpc.ServerCredentials.createSsl(
        caCert,
        [
          {
            cert_chain: nodeCert,
            private_key: nodeKey,
          },
        ],
        true,
      );

      clientCredentials = grpc.credentials.createSsl(caCert, nodeKey, nodeCert);
      this.cachedClientsCredentials = clientCredentials;
    } else {
      serverCredentials = grpc.ServerCredentials.createInsecure();
      clientCredentials = grpc.credentials.createInsecure();

      this.cachedClientsCredentials = clientCredentials;
    }

    return new Promise((resolve, reject) => {
      this.server!.bindAsync(`0.0.0.0:${this.port}`, serverCredentials, (err) => {
        if (err) {
          reject(new NetworkError(`Failed to bind gRPC server: ${err.message}`));
          return;
        }

        for (const [peerId, address] of Object.entries(this.peers)) {
          this.clients.set(peerId, new proto.raft.RaftService(address, clientCredentials, grpcOptions));
        }

        this.started = true;
        resolve();
      });
    });
  }

  /**
   * Stops server and closes all clients with graceful shutdown fallback.
   *
   * @throws NetworkError When transport is not started.
   */
  async stop(): Promise<void> {
    if (!this.started) {
      throw new NetworkError(`Transport for node ${this.nodeId} is not started.`);
    }

    for (const client of this.clients.values()) {
      client.close();
    }
    this.clients.clear();

    return new Promise((resolve) => {
      const forced = setTimeout(() => {
        this.server!.forceShutdown();
        this.finishStop();
        resolve();
      }, this.shutdownTimeoutMs);

      this.server!.tryShutdown((err) => {
        clearTimeout(forced);
        if (err) {
          this.server!.forceShutdown();
        }
        this.finishStop();
        resolve();
      });
    });
  }

  /** Returns true when transport has been started and not yet stopped. */
  isStarted(): boolean {
    return this.started;
  }

  /**
   * Sends one request RPC to a peer and resolves with mapped raft-core response.
   *
   * @param peerId Target peer node id.
   * @param message Outbound raft-core request envelope.
   * @returns Response envelope converted from gRPC payload.
   * @throws NetworkError When transport/peer is unavailable or RPC call fails.
   */
  async send(peerId: NodeId, message: RPCMessage): Promise<RPCMessage> {
    if (!this.started) {
      throw new NetworkError(`Transport for node ${this.nodeId} is not started.`);
    }

    const client = this.clients.get(peerId);
    if (!client) {
      throw new NetworkError(`Peer ${peerId} is not available.`);
    }

    const { method, payload } = rpcMessageToGrpc(message);

    const metadata = new grpc.Metadata();
    metadata.set('from-node', this.nodeId);

    const deadline = new Date(Date.now() + this.callTimeoutMs);

    return new Promise((resolve, reject) => {
      const callback: GrpcClientCallback = (err, response) => {
        if (err) {
          reject(new NetworkError(`Failed to send message from ${this.nodeId} to ${peerId}: ${err.message}`, err));
          return;
        }
        resolve(grpcToRpcMessage(method, response));
      };

      if (method === 'RequestVote') {
        client.RequestVote(payload, metadata, { deadline }, callback);
        return;
      }
      if (method === 'AppendEntries') {
        client.AppendEntries(payload, metadata, { deadline }, callback);
        return;
      }

      client.InstallSnapshot(payload, metadata, { deadline }, callback);
    });
  }

  /** Registers the inbound message handler used by gRPC service methods. */
  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  /**
   * Adds or replaces a gRPC client for a peer.
   *
   * @param peerId Peer node id.
   * @param address Peer gRPC endpoint address.
   * @throws NetworkError When transport is not initialized.
   */
  addPeer(peerId: NodeId, address: string): Promise<void> {
    if (!this.cachedClientsCredentials) {
      return Promise.reject(new NetworkError('Transport is not initialized. Start the transport before adding peers.'));
    }

    const existing = this.clients.get(peerId);
    if (existing) {
      existing.close();
      this.clients.delete(peerId);
    }

    this.clients.set(
      peerId,
      new proto.raft.RaftService(address, this.cachedClientsCredentials, {
        'grpc.enable_retries': 0,
        'grpc.max_receive_message_length': this.maxGrpcMessageBytes,
        'grpc.max_send_message_length': this.maxGrpcMessageBytes,
      }),
    );

    return Promise.resolve();
  }

  /**
   * Removes and closes an existing peer client when present.
   *
   * @param peerId Peer node id.
   */
  removePeer(peerId: NodeId): void {
    const client = this.clients.get(peerId);
    if (client) {
      client.close();
      this.clients.delete(peerId);
    }
  }

  /** Resets in-memory lifecycle state after shutdown. */
  private finishStop() {
    this.started = false;
    this.handler = null;
    this.server = null;
    this.cachedClientsCredentials = null;
  }

  /**
   * Builds gRPC service handlers that adapt protobuf payloads to raft-core RPC messages.
   */
  private buildServiceImplementation(): grpc.UntypedServiceImplementation {
    return {
      RequestVote: (call: GrpcRequestVoteCall, callback: GrpcServiceCallback<RequestVoteResponsePayload>) => {
        if (!this.handler) {
          callback(makeServiceError(grpc.status.UNAVAILABLE, 'No message handler registered'));
          return;
        }
        const handler = this.handler;

        void (async () => {
          try {
            const from = this.extractSender(call);
            const message: RPCMessage = {
              type: 'RequestVote',
              direction: 'request',
              payload: call.request,
            };

            const response = await handler(from, message);

            if (response.type !== 'RequestVote' || response.direction !== 'response') {
              callback(makeServiceError(grpc.status.INTERNAL, 'Invalid response type from handler'));
              return;
            }

            callback(null, response.payload);
          } catch (err) {
            callback(makeServiceError(grpc.status.INTERNAL, (err as Error).message));
          }
        })();
      },

      AppendEntries: (call: GrpcAppendEntriesCall, callback: GrpcServiceCallback<object>) => {
        if (!this.handler) {
          callback(makeServiceError(grpc.status.UNAVAILABLE, 'No message handler registered'));
          return;
        }
        const handler = this.handler;

        void (async () => {
          try {
            const from = this.extractSender(call);
            const entriesRaw = Array.isArray(call.request.entries) ? call.request.entries : [];
            const payload: AppendEntriesRequestPayload = {
              term: call.request.term,
              leaderId: call.request.leaderId,
              prevLogIndex: call.request.prevLogIndex,
              prevLogTerm: call.request.prevLogTerm,
              entries: entriesRaw.map((entry) => deserializeLogEntry(entry)),
              leaderCommit: call.request.leaderCommit,
            };

            const message: RPCMessage = {
              type: 'AppendEntries',
              direction: 'request',
              payload,
            };

            const response = await handler(from, message);

            if (response.type !== 'AppendEntries' || response.direction !== 'response') {
              callback(makeServiceError(grpc.status.INTERNAL, 'Invalid response type from handler'));
              return;
            }

            callback(null, serializeAppendEntriesResponse(response.payload));
          } catch (err) {
            callback(makeServiceError(grpc.status.INTERNAL, (err as Error).message));
          }
        })();
      },

      InstallSnapshot: (
        call: GrpcInstallSnapshotCall,
        callback: GrpcServiceCallback<InstallSnapshotResponsePayload>,
      ) => {
        if (!this.handler) {
          callback(makeServiceError(grpc.status.UNAVAILABLE, 'No message handler registered'));
          return;
        }
        const handler = this.handler;

        void (async () => {
          try {
            const from = this.extractSender(call);
            const parsedConfig: unknown = call.request.config
              ? JSON.parse(call.request.config)
              : { voters: [], learners: [] };

            const payload: InstallSnapshotRequestPayload = {
              term: call.request.term,
              leaderId: call.request.leaderId,
              lastIncludedIndex: call.request.lastIncludedIndex,
              lastIncludedTerm: call.request.lastIncludedTerm,
              offset: call.request.offset,
              done: call.request.done,
              data: Buffer.isBuffer(call.request.data) ? call.request.data : Buffer.from(call.request.data),
              config: parsedConfig as InstallSnapshotRequestPayload['config'],
            };

            const message: RPCMessage = {
              type: 'InstallSnapshot',
              direction: 'request',
              payload,
            };

            const response = await handler(from, message);

            if (response.type !== 'InstallSnapshot' || response.direction !== 'response') {
              callback(makeServiceError(grpc.status.INTERNAL, 'Invalid response type from handler'));
              return;
            }

            callback(null, response.payload);
          } catch (err) {
            callback(makeServiceError(grpc.status.INTERNAL, (err as Error).message));
          }
        })();
      },
    };
  }

  /** Extracts sender node id from inbound gRPC metadata. */
  private extractSender(call: { metadata?: grpc.Metadata }): NodeId {
    const values = call.metadata?.get('from-node');
    if (values && values.length > 0 && typeof values[0] === 'string') {
      return values[0];
    }
    return 'unknown' as NodeId;
  }
}
