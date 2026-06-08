// @author Mathias Bouhon Keulen
// @date 2026-03-20
import {
  ClusterMember,
  Command,
  createConfig,
  DiskNodeStorage,
  NodeId,
  RaftEventBus,
  RaftNode,
} from '@maboke123/raft-core';
import { GrpcTransport } from '@maboke123/raft-grpc';
import { ClusterRunnerInterface, CommittedConfig } from './ClusterRunnerInterface';
import path from 'node:path';
import fs from 'fs/promises';

interface TimerConfig {
  electionTimeoutMin: number;
  electionTimeoutMax: number;
  heartbeatInterval: number;
}

export interface ClusterRunnerOptions {
  nodeCount: number;
  timerConfig: TimerConfig;
}

class NoOpStateMachine {
  async apply(_command: Command): Promise<void> {}
  getState(): null {
    return null;
  }
  takeSnapshot(): Promise<Buffer> {
    return Promise.resolve(Buffer.alloc(0));
  }
  async installSnapshot(_snapshot: Buffer): Promise<void> {}
}

export class ClusterRunnerGRPC implements ClusterRunnerInterface {
  private nodes: Map<NodeId, RaftNode> = new Map();
  private nodeIds: NodeId[] = [];
  private committedConfig: CommittedConfig = { voters: [], learners: [] };

  constructor(
    private bus: RaftEventBus,
    private options: ClusterRunnerOptions,
  ) {}

  async start(): Promise<void> {
    const { nodeCount, timerConfig } = this.options;

    const baseNodeIds: NodeId[] = Array.from({ length: nodeCount }, (_, i) => `node${i + 1}`);

    const persistedMembers = await this.readPersistedConfig(baseNodeIds);

    const addressMap: Record<NodeId, string> = {};
    baseNodeIds.forEach((nodeId, index) => {
      addressMap[nodeId] = `localhost:${52000 + index}`;
    });

    if (persistedMembers) {
      for (const m of [...persistedMembers.voters, ...persistedMembers.learners]) {
        addressMap[m.id] = m.address;
      }
    }

    const allNodeIds: NodeId[] = persistedMembers
      ? [...persistedMembers.voters.map((m) => m.id), ...persistedMembers.learners.map((m) => m.id)]
      : baseNodeIds;

    this.nodeIds = allNodeIds;

    for (const nodeId of allNodeIds) {
      const address = addressMap[nodeId];
      const port = parseInt(address.split(':')[1]);

      const peerMembers = this.nodeIds.filter((id) => id !== nodeId).map((id) => ({ id, address: addressMap[id] }));

      const config = createConfig(
        nodeId,
        address,
        peerMembers,
        timerConfig.electionTimeoutMin,
        timerConfig.electionTimeoutMax,
        timerConfig.heartbeatInterval,
      );

      const nodeStorage = new DiskNodeStorage(path.join(__dirname, '../../../data', nodeId));
      await nodeStorage.open();

      const peers = Object.fromEntries(Object.entries(addressMap).filter(([id]) => id !== nodeId));
      const certPaths = await this.resolveTlsCertPaths(nodeId);

      const transport = new GrpcTransport(nodeId, port, peers, certPaths, 400, 3000);

      const node = new RaftNode({
        config,
        storage: nodeStorage,
        transport,
        stateMachine: new NoOpStateMachine(),
        eventBus: this.bus,
      });

      this.nodes.set(nodeId, node);
    }

    for (const node of this.nodes.values()) {
      await node.start();
    }

    this.committedConfig = persistedMembers ?? {
      voters: baseNodeIds.map((id) => ({ id, address: addressMap[id] })),
      learners: [],
    };
  }

  async stop(): Promise<void> {
    for (const node of this.nodes.values()) {
      if (node.isStarted()) {
        await node.stop();
      }
    }
  }

  getNodeIds(): NodeId[] {
    return [...this.nodeIds];
  }

  async crashNode(nodeId: NodeId): Promise<void> {
    const node = this.nodes.get(nodeId);
    if (node && node.isStarted()) {
      await node.stop();
    }
  }

  async recoverNode(nodeId: NodeId): Promise<void> {
    const node = this.nodes.get(nodeId);
    if (node && !node.isStarted()) {
      await node.start();
    }
  }

  partitionNodes(_groups: NodeId[][]): void {}

  healPartition(): void {}

  setDropRate(_nodeId: NodeId, _rate: number): void {}

  async submitCommand(command: Command, targetLeaderId?: NodeId): Promise<void> {
    const candidates = targetLeaderId
      ? [this.nodes.get(targetLeaderId)!].filter(Boolean)
      : Array.from(this.nodes.values()).filter((n) => n.isStarted() && n.isLeader());

    if (candidates.length === 0) {
      throw new Error('No leader available to submit command');
    }

    const result = await candidates[0].submitCommand(command);
    if (!result.success) {
      throw new Error(`Command submission failed: ${result.error}`);
    }
  }

  cutLink(_nodeA: NodeId, _nodeB: NodeId): void {}

  healLink(_nodeA: NodeId, _nodeB: NodeId): void {}

  healAllLinks(): void {}

  async addServer(nodeId: NodeId, address: string, asLearner: boolean): Promise<void> {
    if (this.nodes.has(nodeId)) {
      throw new Error(`Node ${nodeId} already exists in the cluster`);
    }

    const port = parseInt(address.split(':')[1]);
    if (isNaN(port)) {
      throw new Error(`Invalid address format: ${address}`);
    }

    const leader = Array.from(this.nodes.values()).find((n) => n.isStarted() && n.isLeader());
    if (!leader) {
      throw new Error('No leader available to add server');
    }

    const allCurrentMembers = [...this.committedConfig.voters, ...this.committedConfig.learners];

    const peers = Object.fromEntries(allCurrentMembers.map((m) => [m.id, m.address]));
    const peerMembers = allCurrentMembers.map((m) => ({ id: m.id, address: m.address }));

    const config = createConfig(
      nodeId,
      address,
      peerMembers,
      this.options.timerConfig.electionTimeoutMin,
      this.options.timerConfig.electionTimeoutMax,
      this.options.timerConfig.heartbeatInterval,
    );

    const nodeStorage = new DiskNodeStorage(path.join(__dirname, '../../../data', nodeId));
    await nodeStorage.open();
    const certPaths = await this.resolveTlsCertPaths(nodeId);

    const transport = new GrpcTransport(nodeId, port, peers, certPaths, 400, 3000);

    const node = new RaftNode({
      config,
      storage: nodeStorage,
      transport,
      stateMachine: new NoOpStateMachine(),
      eventBus: this.bus,
    });

    this.nodes.set(nodeId, node);
    this.nodeIds.push(nodeId);

    await node.start();

    for (const [existingId, existingNode] of this.nodes) {
      if (existingId !== nodeId && existingNode.isStarted()) {
        await existingNode.registerPeer(nodeId, address);
      }
    }

    const success = await leader.addServer(nodeId, address, asLearner);

    if (!success) {
      this.nodes.delete(nodeId);
      this.nodeIds.pop();
      await node.stop();
      throw new Error(`Failed to add server ${nodeId} to the cluster`);
    }

    const member = { id: nodeId, address };
    if (asLearner) {
      this.committedConfig = {
        voters: this.committedConfig.voters,
        learners: [...this.committedConfig.learners, member],
      };
    } else {
      this.committedConfig = {
        voters: [...this.committedConfig.voters, member],
        learners: this.committedConfig.learners,
      };
    }
  }

  async removeServer(nodeId: NodeId): Promise<void> {
    const leader = Array.from(this.nodes.values()).find((n) => n.isStarted() && n.isLeader());
    if (!leader) {
      throw new Error('No leader available to remove server');
    }

    await leader.removeServer(nodeId);

    const node = this.nodes.get(nodeId);
    if (node && node.isStarted()) {
      await node.stop();
    }

    for (const [existingId, existingNode] of this.nodes) {
      if (existingId !== nodeId && existingNode.isStarted()) {
        await existingNode.removePeer(nodeId);
      }
    }

    this.nodes.delete(nodeId);
    this.nodeIds = this.nodeIds.filter((id) => id !== nodeId);
    this.committedConfig = {
      voters: this.committedConfig.voters.filter((m) => m.id !== nodeId),
      learners: this.committedConfig.learners.filter((m) => m.id !== nodeId),
    };

    await fs.rm(path.join(__dirname, '../../../data', nodeId), { recursive: true, force: true });
  }

  async promoteServer(nodeId: NodeId): Promise<void> {
    const leader = Array.from(this.nodes.values()).find((n) => n.isStarted() && n.isLeader());
    if (!leader) {
      throw new Error('No leader available to promote server');
    }

    await leader.promoteServer(nodeId);

    const member = this.committedConfig.learners.find((m) => m.id === nodeId);
    if (member) {
      this.committedConfig = {
        voters: [...this.committedConfig.voters, member],
        learners: this.committedConfig.learners.filter((m) => m.id !== nodeId),
      };
    }
  }

  getCommittedConfig(): CommittedConfig {
    return this.committedConfig;
  }

  isLeader(nodeId: NodeId): boolean {
    const node = this.nodes.get(nodeId);
    return node !== undefined && node.isStarted() && node.isLeader();
  }

  private async readPersistedConfig(
    baseNodeIds: NodeId[],
  ): Promise<{ voters: ClusterMember[]; learners: ClusterMember[] } | null> {
    for (const seedNodeId of baseNodeIds) {
      const nodeStorage = new DiskNodeStorage(path.join(__dirname, '../../../data', seedNodeId));
      try {
        await nodeStorage.open();
        const data = await nodeStorage.config.read();
        await nodeStorage.close();
        if (!data) continue;
        return { voters: data.voters, learners: data.learners };
      } catch {
        try {
          await nodeStorage.close();
        } catch {
          void 0;
        }
      }
    }
    return null;
  }

  private async resolveTlsCertPaths(nodeId: NodeId): Promise<
    | {
        caCert: string;
        nodeCert: string;
        nodeKey: string;
      }
    | undefined
  > {
    const certPaths = {
      caCert: path.join(__dirname, '../../../certs/ca/ca.crt'),
      nodeCert: path.join(__dirname, `../../../certs/${nodeId}`, `${nodeId}.crt`),
      nodeKey: path.join(__dirname, `../../../certs/${nodeId}`, `${nodeId}.key`),
    };

    try {
      await Promise.all([fs.access(certPaths.caCert), fs.access(certPaths.nodeCert), fs.access(certPaths.nodeKey)]);
      return certPaths;
    } catch {
      return undefined;
    }
  }
}
