// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { NodeId } from '../core/Config';
import { RPCMessage } from '../rpc/RPCTypes';
import { NetworkError } from '../util/Error';
import { Random, SystemRandom } from '../util/Random';
import { Transport, MessageHandler } from './Transport';

/**
 * In-memory transport used for deterministic tests and failure simulation.
 */
export class MockTransport implements Transport {
  private handler: MessageHandler | null = null;
  private started: boolean = false;
  private dropRate: number = 0;

  private static transports: Map<NodeId, MockTransport> = new Map();
  private static partitions: Set<NodeId>[] = [];
  private static blockedPairs: Set<string> = new Set();

  constructor(
    private readonly nodeId: NodeId,
    private readonly random: Random = new SystemRandom(),
  ) {}

  /** Registers this transport instance in the shared in-memory transport map. */
  async start(): Promise<void> {
    if (this.started) {
      throw new NetworkError(`Transport for node ${this.nodeId} is already started.`);
    }

    this.started = true;
    MockTransport.transports.set(this.nodeId, this);
    await Promise.resolve();
  }

  /** Stops this transport instance and unregisters it from the shared in-memory transport map. */
  async stop(): Promise<void> {
    if (!this.started) {
      throw new NetworkError(`Transport for node ${this.nodeId} is not started.`);
    }
    this.started = false;
    this.handler = null;
    MockTransport.transports.delete(this.nodeId);
    await Promise.resolve();
  }

  /** Returns true when transport is started. */
  isStarted(): boolean {
    return this.started;
  }

  /**
   * Sends an RPC message to a peer with optional simulated failures.
   */
  async send(peerId: NodeId, message: RPCMessage): Promise<RPCMessage> {
    if (!this.started) {
      throw new NetworkError(`Transport for node ${this.nodeId} is not started.`);
    }

    // changed drop rate from only effect on sending to also experience dropped incoming messages
    const peerTransport = MockTransport.transports.get(peerId);
    const effectiveDropRate = Math.max(this.dropRate, peerTransport?.getDropRate() ?? 0);

    if (this.random.nextFloat() < effectiveDropRate) {
      throw new NetworkError(
        `Message from ${this.nodeId} to ${peerId} was dropped due to simulated network conditions.`,
      );
    }

    if (MockTransport.isPartitioned(this.nodeId, peerId)) {
      throw new NetworkError(`Message from ${this.nodeId} to ${peerId} was dropped due to network partition.`);
    }

    if (MockTransport.isLinkBlocked(this.nodeId, peerId)) {
      throw new NetworkError(`Message from ${this.nodeId} to ${peerId} was dropped due to cut link.`);
    }

    if (!peerTransport || !peerTransport.isStarted()) {
      throw new NetworkError(`Peer ${peerId} is not available.`);
    }

    if (!peerTransport.handler) {
      throw new NetworkError(`Peer ${peerId} does not have a message handler registered.`);
    }

    try {
      return await peerTransport.handler(this.nodeId, message);
    } catch (error) {
      throw new NetworkError(
        `Failed to send message from ${this.nodeId} to ${peerId}: ${(error as Error).message}`,
        error as Error,
      );
    }
  }

  /** Registers inbound message handler for this transport instance. */
  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  /** Sets local packet drop probability for this node. */
  setDropRate(dropRate: number): void {
    if (typeof dropRate !== 'number' || dropRate < 0 || dropRate > 1) {
      throw new NetworkError(`Invalid drop rate: ${dropRate}. Drop rate must be a number between 0 and 1.`);
    }
    this.dropRate = dropRate;
  }

  /** Sets packet drop probability for a registered node by id. */
  static setDropRate(nodeId: NodeId, dropRate: number): void {
    const transport = MockTransport.transports.get(nodeId);
    if (!transport) {
      return;
    }
    transport.setDropRate(dropRate);
  }

  /** Returns local packet drop probability for this node. */
  getDropRate(): number {
    return this.dropRate;
  }

  /** Creates simulated network partition groups. */
  static partition(...groups: NodeId[][]): void {
    MockTransport.partitions = groups.map((group) => new Set(group));
  }

  /** Clears all partition groups. */
  static healPartition(): void {
    MockTransport.partitions = [];
  }

  /** Returns true when two nodes are in different simulated partitions. */
  static isPartitioned(nodeA: NodeId, nodeB: NodeId): boolean {
    if (MockTransport.partitions.length === 0) {
      return false;
    }

    let fromPartition: Set<NodeId> | null = null;
    let toPartition: Set<NodeId> | null = null;

    for (const partition of MockTransport.partitions) {
      if (partition.has(nodeA)) {
        fromPartition = partition;
      }

      if (partition.has(nodeB)) {
        toPartition = partition;
      }

      if (fromPartition && toPartition) {
        break;
      }
    }

    if (!fromPartition) {
      fromPartition = new Set([nodeA]);
    }

    if (!toPartition) {
      toPartition = new Set([nodeB]);
    }

    return fromPartition !== toPartition;
  }

  /** Resets global mock transport state. */
  static reset(): void {
    MockTransport.transports.clear();
    MockTransport.partitions = [];
    MockTransport.blockedPairs.clear();
  }

  /** Returns list of currently registered node ids. */
  static getRegisteredNodes(): NodeId[] {
    return Array.from(MockTransport.transports.keys());
  }

  /** Simulates a bidirectional link cut between two nodes. */
  static cutLink(nodeA: NodeId, nodeB: NodeId): void {
    MockTransport.blockedPairs.add(`${nodeA}-${nodeB}`);
    MockTransport.blockedPairs.add(`${nodeB}-${nodeA}`);
  }

  /** Heals a previously cut bidirectional link between two nodes. */
  static healLink(nodeA: NodeId, nodeB: NodeId): void {
    MockTransport.blockedPairs.delete(`${nodeA}-${nodeB}`);
    MockTransport.blockedPairs.delete(`${nodeB}-${nodeA}`);
  }

  /** Heals all cut links. */
  static healAllLinks(): void {
    MockTransport.blockedPairs.clear();
  }

  /** Returns true when link between two nodes is currently blocked. */
  static isLinkBlocked(nodeA: NodeId, nodeB: NodeId): boolean {
    return MockTransport.blockedPairs.has(`${nodeA}-${nodeB}`);
  }
}
