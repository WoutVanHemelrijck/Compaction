// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { ClusterConfig, Command, NodeId, RaftEvent } from '@maboke123/raft-core';

export interface InitialStateMessage {
  type: 'InitialState';
  events: RaftEvent[];
  nodeIds: NodeId[];
  config?: ClusterConfig;
}

export interface LiveEventMessage {
  type: 'LiveEvent';
  event: RaftEvent;
}

export type ServerMessage = InitialStateMessage | LiveEventMessage;

export interface SubmitCommandMessage {
  type: 'SubmitCommand';
  command: Command;
}

export interface CrashNodeMessage {
  type: 'CrashNode';
  nodeId: NodeId;
}

export interface RecoverNodeMessage {
  type: 'RecoverNode';
  nodeId: NodeId;
}

export interface PartitionNodesMessage {
  type: 'PartitionNodes';
  groups: NodeId[][];
}

export interface HealPartitionMessage {
  type: 'HealPartition';
}

export interface SetDropRateMessage {
  type: 'SetDropRate';
  nodeId: NodeId;
  dropRate: number;
}

export interface CutLinkMessage {
  type: 'CutLink';
  nodeA: NodeId;
  nodeB: NodeId;
}

export interface HealLinkMessage {
  type: 'HealLink';
  nodeA: NodeId;
  nodeB: NodeId;
}

export interface HealAllLinksMessage {
  type: 'HealAllLinks';
}

export interface AddServerMessage {
  type: 'AddServer';
  nodeId: NodeId;
  address: string;
  asLearner: boolean;
}

export interface RemoveServerMessage {
  type: 'RemoveServer';
  nodeId: NodeId;
}

export interface PromoteLearnerMessage {
  type: 'PromoteLearner';
  nodeId: NodeId;
}

export type ClientMessage =
  | SubmitCommandMessage
  | CrashNodeMessage
  | RecoverNodeMessage
  | PartitionNodesMessage
  | HealPartitionMessage
  | SetDropRateMessage
  | CutLinkMessage
  | HealLinkMessage
  | HealAllLinksMessage
  | AddServerMessage
  | RemoveServerMessage
  | PromoteLearnerMessage;
