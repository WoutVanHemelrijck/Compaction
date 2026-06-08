// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { EventStore } from '@maboke123/raft-core';
import { ClientMessage, ServerMessage } from './WsProtocol';
import { ClusterRunnerInterface } from './ClusterRunnerInterface';

type WsMessageData = string | Buffer | ArrayBuffer | Buffer[];

interface WsClient {
  readyState: number;
  send(data: string): void;
  on(event: 'message', listener: (data: WsMessageData) => void): void;
  on(event: 'close', listener: () => void): void;
  on(event: 'error', listener: (err: unknown) => void): void;
}

interface WsServerInstance {
  on(event: 'listening', listener: () => void): void;
  on(event: 'connection', listener: (ws: WsClient) => void): void;
  close(listener: () => void): void;
}

interface WsModule {
  WebSocketServer: new (options: { port: number }) => WsServerInstance;
  WebSocket: { OPEN: number };
}

function isWsModule(value: unknown): value is WsModule {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const webSocketValue = candidate.WebSocket;
  const webSocketIsObjectLike = typeof webSocketValue === 'object' || typeof webSocketValue === 'function';
  return (
    typeof candidate.WebSocketServer === 'function' &&
    webSocketIsObjectLike &&
    webSocketValue !== null &&
    typeof (webSocketValue as Record<string, unknown>).OPEN === 'number'
  );
}

function toWsModuleFromFunction(value: unknown): WsModule | undefined {
  if (typeof value !== 'function') {
    return undefined;
  }

  const candidate = value as unknown as Record<string, unknown>;
  if (typeof candidate.WebSocketServer !== 'function' || typeof candidate.OPEN !== 'number') {
    return undefined;
  }

  return {
    WebSocketServer: candidate.WebSocketServer as new (options: { port: number }) => WsServerInstance,
    WebSocket: { OPEN: candidate.OPEN },
  };
}

function toWsModule(value: unknown): WsModule {
  if (isWsModule(value)) {
    return value;
  }

  const functionModule = toWsModuleFromFunction(value);
  if (functionModule) {
    return functionModule;
  }

  if (typeof value === 'object' && value !== null && 'default' in value) {
    const candidate = (value as { default?: unknown }).default;
    if (isWsModule(candidate)) {
      return candidate;
    }

    const defaultFunctionModule = toWsModuleFromFunction(candidate);
    if (defaultFunctionModule) {
      return defaultFunctionModule;
    }
  }

  throw new Error('Invalid ws module shape');
}

export class WsServer {
  private wss: WsServerInstance | null = null;
  private wsModule: WsModule | null = null;
  private wsModulePromise: Promise<WsModule> | null = null;

  constructor(
    private eventStore: EventStore,
    private cluster: ClusterRunnerInterface,
    private port: number = 4001,
  ) {}

  start(): void {
    void this.startInternal();
  }

  stop(): void {
    if (this.wss) {
      this.wss.close(() => {
        console.log('WebSocket server stopped');
      });
    }
  }

  private async startInternal(): Promise<void> {
    const wsModule = await this.getWsModule();
    this.wss = new wsModule.WebSocketServer({ port: this.port });

    this.wss.on('listening', () => {
      console.log(`WebSocket server started on port ${this.port}`);
    });

    this.wss.on('connection', (wsClient) => {
      console.log('New client connected');
      this.handleConnection(wsClient, wsModule.WebSocket.OPEN);
    });
  }

  private async getWsModule(): Promise<WsModule> {
    if (this.wsModule) {
      return this.wsModule;
    }
    if (!this.wsModulePromise) {
      this.wsModulePromise = (async () => {
        const moduleUnknown: unknown = await import('ws');
        const wsModule = toWsModule(moduleUnknown);
        this.wsModule = wsModule;
        return wsModule;
      })();
    }
    return this.wsModulePromise;
  }

  private handleConnection(wsClient: WsClient, openState: number): void {
    const initial: ServerMessage = {
      type: 'InitialState',
      events: this.eventStore.getAllEvents(),
      nodeIds: this.cluster.getNodeIds(),
      config: this.cluster.getCommittedConfig(),
    };

    wsClient.send(JSON.stringify(initial));

    const unsubscribe = this.eventStore.onLiveEvent((event) => {
      if (wsClient.readyState !== openState) {
        return;
      }

      setImmediate(() => {
        const message: ServerMessage = {
          type: 'LiveEvent',
          event,
        };
        wsClient.send(JSON.stringify(message));
      });
    });

    wsClient.on('message', (data: WsMessageData) => {
      try {
        const parsed: unknown = JSON.parse(this.rawDataToString(data));
        if (!this.isClientMessage(parsed)) {
          console.warn('Ignoring invalid client message:', parsed);
          return;
        }
        this.handleMessage(parsed);
      } catch (err) {
        console.error('Failed to parse message from client:', err);
      }
    });

    wsClient.on('close', () => {
      console.log('Client disconnected');
      unsubscribe();
    });

    wsClient.on('error', (err) => {
      console.error('WebSocket error:', err);
      unsubscribe();
    });
  }

  private rawDataToString(data: WsMessageData): string {
    if (typeof data === 'string') {
      return data;
    }
    if (data instanceof ArrayBuffer) {
      return Buffer.from(data).toString('utf8');
    }
    if (Array.isArray(data)) {
      return Buffer.concat(data).toString('utf8');
    }
    return data.toString('utf8');
  }

  private isClientMessage(value: unknown): value is ClientMessage {
    if (!this.isRecord(value) || typeof value.type !== 'string') {
      return false;
    }

    switch (value.type) {
      case 'SubmitCommand':
        return 'command' in value;
      case 'CrashNode':
      case 'RecoverNode':
      case 'RemoveServer':
      case 'PromoteLearner':
        return this.hasString(value, 'nodeId');
      case 'PartitionNodes':
        return (
          Array.isArray(value.groups) &&
          value.groups.every((group) => Array.isArray(group) && group.every((nodeId) => typeof nodeId === 'string'))
        );
      case 'HealPartition':
      case 'HealAllLinks':
        return true;
      case 'SetDropRate':
        return this.hasString(value, 'nodeId') && typeof value.dropRate === 'number';
      case 'CutLink':
      case 'HealLink':
        return this.hasString(value, 'nodeA') && this.hasString(value, 'nodeB');
      case 'AddServer':
        return (
          this.hasString(value, 'nodeId') && this.hasString(value, 'address') && typeof value.asLearner === 'boolean'
        );
      default:
        return false;
    }
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  private hasString(obj: Record<string, unknown>, key: string): boolean {
    return typeof obj[key] === 'string';
  }

  private getErrorMessage(err: unknown): string {
    if (err instanceof Error) {
      return err.message;
    }
    return String(err);
  }

  private handleMessage(message: ClientMessage): void {
    switch (message.type) {
      case 'SubmitCommand':
        this.cluster
          .submitCommand(message.command)
          .catch((err: unknown) => console.error('SubmitCommand failed:', this.getErrorMessage(err)));
        break;
      case 'CrashNode':
        this.cluster
          .crashNode(message.nodeId)
          .catch((err: unknown) => console.error('CrashNode failed:', this.getErrorMessage(err)));
        break;
      case 'RecoverNode':
        this.cluster
          .recoverNode(message.nodeId)
          .catch((err: unknown) => console.error('RecoverNode failed:', this.getErrorMessage(err)));
        break;
      case 'PartitionNodes':
        this.cluster.partitionNodes(message.groups);
        break;
      case 'HealPartition':
        this.cluster.healPartition();
        break;
      case 'SetDropRate':
        this.cluster.setDropRate(message.nodeId, message.dropRate);
        break;
      case 'CutLink':
        this.cluster.cutLink(message.nodeA, message.nodeB);
        break;
      case 'HealLink':
        this.cluster.healLink(message.nodeA, message.nodeB);
        break;
      case 'HealAllLinks':
        this.cluster.healAllLinks();
        break;
      case 'AddServer':
        this.cluster
          .addServer(message.nodeId, message.address, message.asLearner)
          .catch((err: unknown) => console.error('AddServer failed:', this.getErrorMessage(err)));
        break;
      case 'RemoveServer':
        this.cluster
          .removeServer(message.nodeId)
          .catch((err: unknown) => console.error('RemoveServer failed:', this.getErrorMessage(err)));
        break;
      case 'PromoteLearner':
        this.cluster
          .promoteServer(message.nodeId)
          .catch((err: unknown) => console.error('PromoteLearner failed:', this.getErrorMessage(err)));
        break;
      default:
        console.warn('Unknown message type from client:', message);
    }
  }
}
