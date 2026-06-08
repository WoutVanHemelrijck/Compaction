// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { Command, NodeId } from '@maboke123/raft-core';

export interface CommittedConfig {
  voters: { id: NodeId; address: string }[];
  learners: { id: NodeId; address: string }[];
}

export interface ClusterRunnerInterface {
  start(): Promise<void>;
  stop(): Promise<void>;
  getNodeIds(): NodeId[];
  crashNode(nodeId: NodeId): Promise<void>;
  recoverNode(nodeId: NodeId): Promise<void>;
  partitionNodes(groups: NodeId[][]): void;
  healPartition(): void;
  setDropRate(nodeId: NodeId, rate: number): void;
  submitCommand(command: Command, targetLeaderId?: NodeId): Promise<void>;
  cutLink(nodeA: NodeId, nodeB: NodeId): void;
  healLink(nodeA: NodeId, nodeB: NodeId): void;
  healAllLinks(): void;
  addServer(nodeId: NodeId, address: string, asLearner: boolean): Promise<void>;
  removeServer(nodeId: NodeId): Promise<void>;
  promoteServer(nodeId: NodeId): Promise<void>;
  getCommittedConfig(): CommittedConfig;
  isLeader(nodeId: NodeId): boolean;
}
