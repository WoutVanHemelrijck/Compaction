// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { NodeId } from '../core/Config';
import {
  RequestVoteRequest,
  RequestVoteResponse,
  AppendEntriesRequest,
  AppendEntriesResponse,
  isRequestVoteRequestMessage,
  isRequestVoteResponseMessage,
  isAppendEntriesRequestMessage,
  isAppendEntriesResponseMessage,
  validateRPCMessage,
  RPCMessage,
  InstallSnapshotRequest,
  InstallSnapshotResponse,
  isInstallSnapshotResponseMessage,
  isInstallSnapshotRequestMessage,
} from './RPCTypes';
import { Transport } from '../transport/Transport';
import { Logger } from '../util/Logger';
import { Clock, TimerHandle } from '../timing/Clock';
import { RPCHandlerError, NetworkError } from '../util/Error';
import { RaftEventBus } from '../events/RaftEvents';
import { NoOpEventBus } from '../events/EventBus';

/**
 * Optional send behavior for outbound RPC calls.
 */
export interface RPCSendOptions {
  /** Per-request timeout override in milliseconds. */
  timeoutMs?: number;
}

/**
 * RPC handler contract for outbound Raft protocol calls.
 */
export interface RPCHandlerInterface {
  sendRequestVote(peerId: NodeId, request: RequestVoteRequest, options?: RPCSendOptions): Promise<RequestVoteResponse>;
  sendAppendEntries(
    peerId: NodeId,
    request: AppendEntriesRequest,
    options?: RPCSendOptions,
  ): Promise<AppendEntriesResponse>;
  sendInstallSnapshot(
    peerId: NodeId,
    request: InstallSnapshotRequest,
    options?: RPCSendOptions,
  ): Promise<InstallSnapshotResponse>;
}

/**
 * Transport-facing RPC utility for sending and dispatching Raft messages.
 *
 * @remarks
 * Performs message validation, timeout handling, response type checks, and event
 * emission around protocol traffic.
 */
export class RPCHandler implements RPCHandlerInterface {
  private static readonly default_timeout_ms = 1000;

  constructor(
    private nodeId: NodeId,
    private transport: Transport,
    private logger: Logger,
    private clock: Clock,
    private eventBus: RaftEventBus = new NoOpEventBus(),
  ) {}

  /**
   * Sends a RequestVote RPC and validates the corresponding response type.
   *
   * @param peerId Target peer id.
   * @param request RequestVote payload.
   * @param options Optional timeout override.
   * @returns RequestVote response payload.
   */
  async sendRequestVote(
    peerId: NodeId,
    request: RequestVoteRequest,
    options?: RPCSendOptions,
  ): Promise<RequestVoteResponse> {
    const message: RPCMessage = {
      type: 'RequestVote',
      direction: 'request',
      payload: request,
    };

    validateRPCMessage(message);

    this.logger.debug(`Node ${this.nodeId} sending RequestVote to ${peerId}: ${JSON.stringify(request)}`);

    const messageId = crypto.randomUUID();
    const sentAt = performance.now();

    this.eventBus.emit({
      eventId: crypto.randomUUID(),
      timestamp: sentAt,
      wallTime: Date.now(),
      nodeId: this.nodeId,
      type: 'MessageSent',
      messageType: 'RequestVote',
      messageId: messageId,
      fromNodeId: this.nodeId,
      toNodeId: peerId,
      term: request.term,
      payload: request,
    });

    try {
      const response = await this.sendWithTimeout(peerId, message, options);

      if (!isRequestVoteResponseMessage(response)) {
        throw new RPCHandlerError(
          `Invalid response type for RequestVote: expected RequestVoteResponse, got ${response.type}`,
        );
      }

      this.logger.debug(
        `Node ${this.nodeId} received RequestVoteResponse from ${peerId}: ${JSON.stringify(response.payload)}`,
      );

      this.eventBus.emit({
        eventId: crypto.randomUUID(),
        timestamp: performance.now(),
        wallTime: Date.now(),
        nodeId: this.nodeId,
        type: 'MessageReceived',
        messageType: 'RequestVoteResponse',
        messageId: messageId,
        fromNodeId: peerId,
        toNodeId: this.nodeId,
        term: response.payload.term,
        payload: response.payload,
        latencyMs: performance.now() - sentAt,
      });

      return response.payload;
    } catch (error) {
      this.eventBus.emit({
        eventId: crypto.randomUUID(),
        timestamp: performance.now(),
        wallTime: Date.now(),
        nodeId: this.nodeId,
        type: 'MessageDropped',
        messageType: 'RequestVote',
        messageId: messageId,
        fromNodeId: this.nodeId,
        toNodeId: peerId,
        term: request.term,
        reason: error instanceof RPCHandlerError ? 'timeout' : 'peer down',
      });

      throw error;
    }
  }

  /**
   * Sends an AppendEntries RPC and validates the corresponding response type.
   *
   * @param peerId Target peer id.
   * @param request AppendEntries payload.
   * @param options Optional timeout override.
   * @returns AppendEntries response payload.
   */
  async sendAppendEntries(
    peerId: NodeId,
    request: AppendEntriesRequest,
    options?: RPCSendOptions,
  ): Promise<AppendEntriesResponse> {
    const message: RPCMessage = {
      type: 'AppendEntries',
      direction: 'request',
      payload: request,
    };

    validateRPCMessage(message);

    this.logger.debug(`Node ${this.nodeId} sending AppendEntries to ${peerId}: ${JSON.stringify(request)}`);

    const messageId = crypto.randomUUID();
    const sentAt = performance.now();

    this.eventBus.emit({
      eventId: crypto.randomUUID(),
      timestamp: sentAt,
      wallTime: Date.now(),
      nodeId: this.nodeId,
      type: 'MessageSent',
      messageType: 'AppendEntries',
      messageId: messageId,
      fromNodeId: this.nodeId,
      toNodeId: peerId,
      term: request.term,
      payload: request,
    });

    try {
      const response = await this.sendWithTimeout(peerId, message, options);

      if (!isAppendEntriesResponseMessage(response)) {
        throw new RPCHandlerError(
          `Invalid response type for AppendEntries: expected AppendEntriesResponse, got ${response.type}`,
        );
      }

      this.logger.debug(
        `Node ${this.nodeId} received AppendEntriesResponse from ${peerId}: ${JSON.stringify(response.payload)}`,
      );

      this.eventBus.emit({
        eventId: crypto.randomUUID(),
        timestamp: performance.now(),
        wallTime: Date.now(),
        nodeId: this.nodeId,
        type: 'MessageReceived',
        messageType: 'AppendEntriesResponse',
        messageId: messageId,
        fromNodeId: peerId,
        toNodeId: this.nodeId,
        term: response.payload.term,
        payload: response.payload,
        latencyMs: performance.now() - sentAt,
      });

      return response.payload;
    } catch (error) {
      this.eventBus.emit({
        eventId: crypto.randomUUID(),
        timestamp: performance.now(),
        wallTime: Date.now(),
        nodeId: this.nodeId,
        type: 'MessageDropped',
        messageType: 'AppendEntries',
        messageId: messageId,
        fromNodeId: this.nodeId,
        toNodeId: peerId,
        term: request.term,
        reason: error instanceof RPCHandlerError ? 'timeout' : 'peer down',
      });

      throw error;
    }
  }

  /**
   * Sends an InstallSnapshot RPC and validates the corresponding response type.
   *
   * @param peerId Target peer id.
   * @param request InstallSnapshot payload.
   * @param options Optional timeout override.
   * @returns InstallSnapshot response payload.
   */
  async sendInstallSnapshot(
    peerId: NodeId,
    request: InstallSnapshotRequest,
    options?: RPCSendOptions,
  ): Promise<InstallSnapshotResponse> {
    const message: RPCMessage = {
      type: 'InstallSnapshot',
      direction: 'request',
      payload: request,
    };

    validateRPCMessage(message);

    const messageId = crypto.randomUUID();
    const sentAt = performance.now();

    this.eventBus.emit({
      eventId: crypto.randomUUID(),
      timestamp: sentAt,
      wallTime: Date.now(),
      nodeId: this.nodeId,
      type: 'MessageSent',
      messageType: 'InstallSnapshotRequest',
      messageId: messageId,
      fromNodeId: this.nodeId,
      toNodeId: peerId,
      term: request.term,
      payload: request,
    });

    this.logger.debug(`Node ${this.nodeId} sending InstallSnapshot to ${peerId}: ${JSON.stringify(request)}`);

    try {
      const response = await this.sendWithTimeout(peerId, message, options);

      if (!isInstallSnapshotResponseMessage(response)) {
        throw new RPCHandlerError(
          `Invalid response type for InstallSnapshot: expected InstallSnapshotResponse, got ${response.type}`,
        );
      }

      this.logger.debug(
        `Node ${this.nodeId} received InstallSnapshotResponse from ${peerId}: ${JSON.stringify(response.payload)}`,
      );

      this.eventBus.emit({
        eventId: crypto.randomUUID(),
        timestamp: performance.now(),
        wallTime: Date.now(),
        nodeId: this.nodeId,
        type: 'MessageReceived',
        messageType: 'InstallSnapshotResponse',
        messageId: messageId,
        fromNodeId: peerId,
        toNodeId: this.nodeId,
        term: response.payload.term,
        payload: response.payload,
        latencyMs: performance.now() - sentAt,
      });

      return response.payload;
    } catch (error) {
      this.logger.warn(`Failed to send InstallSnapshot to ${peerId}`, { error });

      this.eventBus.emit({
        eventId: crypto.randomUUID(),
        timestamp: performance.now(),
        wallTime: Date.now(),
        nodeId: this.nodeId,
        type: 'MessageDropped',
        messageType: 'InstallSnapshotRequest',
        messageId: messageId,
        fromNodeId: this.nodeId,
        toNodeId: peerId,
        term: request.term,
        reason: error instanceof RPCHandlerError ? 'timeout' : 'peer down',
      });

      throw error;
    }
  }

  /**
   * Sends one RPC message with timeout enforcement.
   *
   * @param peerId Target peer id.
   * @param message Outbound RPC message.
   * @param options Optional timeout override.
   * @returns Raw RPC response message from transport.
   * @throws RPCHandlerError On timeout.
   */
  private async sendWithTimeout(peerId: NodeId, message: RPCMessage, options?: RPCSendOptions): Promise<RPCMessage> {
    const timeoutMs = options?.timeoutMs ?? RPCHandler.default_timeout_ms;
    let timeoutHandle: TimerHandle | null = null;

    const timeoutPromise: Promise<RPCMessage> = new Promise((_resolve, reject) => {
      timeoutHandle = this.clock.setTimeout(() => {
        reject(new RPCHandlerError(`RPC to ${peerId} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
    });

    try {
      const result = await Promise.race<RPCMessage>([this.transport.send(peerId, message), timeoutPromise]);

      this.clock.clearTimeout(timeoutHandle!);

      return result;
    } catch (error) {
      this.clock.clearTimeout(timeoutHandle!);

      if (error instanceof RPCHandlerError) {
        this.logger.warn('RPC timeout', { to: peerId, messageType: message.type, timeoutMs });
      } else if (error instanceof NetworkError) {
        this.logger.warn('Network error during RPC', { to: peerId, messageType: message.type, error });
      } else {
        this.logger.error('Unexpected error during RPC', { to: peerId, messageType: message.type, error });
      }
      throw error;
    }
  }

  /**
   * Dispatches incoming request message to protocol handlers and wraps response.
   *
   * @param from Sender node id.
   * @param message Incoming request message.
   * @param handler Handler set for each supported RPC request type.
   * @returns RPC response message for transport reply.
   * @throws RPCHandlerError When message type is unknown.
   */
  async handleIncomingMessage(
    from: NodeId,
    message: RPCMessage,
    handler: {
      onRequestVote: (from: NodeId, request: RequestVoteRequest) => Promise<RequestVoteResponse>;
      onAppendEntries: (from: NodeId, request: AppendEntriesRequest) => Promise<AppendEntriesResponse>;
      onInstallSnapshot: (from: NodeId, request: InstallSnapshotRequest) => Promise<InstallSnapshotResponse>;
    },
  ): Promise<RPCMessage> {
    this.logger.debug(`Node ${this.nodeId} received message from ${from}: ${JSON.stringify(message)}`);

    if (isRequestVoteRequestMessage(message)) {
      const responsePayload = await handler.onRequestVote(from, message.payload);
      return {
        type: 'RequestVote',
        direction: 'response',
        payload: responsePayload,
      };
    } else if (isAppendEntriesRequestMessage(message)) {
      const responsePayload = await handler.onAppendEntries(from, message.payload);
      return {
        type: 'AppendEntries',
        direction: 'response',
        payload: responsePayload,
      };
    } else if (isInstallSnapshotRequestMessage(message)) {
      const responsePayload = await handler.onInstallSnapshot(from, message.payload);
      return {
        type: 'InstallSnapshot',
        direction: 'response',
        payload: responsePayload,
      };
    } else {
      throw new RPCHandlerError(`Unknown message type: ${message.type}`);
    }
  }
}
