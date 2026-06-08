// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { NodeId } from '../core/Config';

/**
 * Cluster member identity and transport address.
 */
export interface ClusterMember {
  id: NodeId;
  address: string;
}

/**
 * Cluster membership split into voters and learners.
 */
export interface ClusterConfig {
  voters: ClusterMember[];
  learners: ClusterMember[];
}

/**
 * Compares two configurations by voter and learner membership ids.
 */
export function clusterConfigsEqual(a: ClusterConfig, b: ClusterConfig): boolean {
  if (a.voters.length !== b.voters.length) return false;
  if (a.learners.length !== b.learners.length) return false;

  const aVoters = [...a.voters].map((m) => m.id).sort();
  const bVoters = [...b.voters].map((m) => m.id).sort();

  for (let i = 0; i < aVoters.length; i++) {
    if (aVoters[i] !== bVoters[i]) return false;
  }

  const aLearners = [...a.learners].map((m) => m.id).sort();
  const bLearners = [...b.learners].map((m) => m.id).sort();

  for (let i = 0; i < aLearners.length; i++) {
    if (aLearners[i] !== bLearners[i]) return false;
  }
  return true;
}

/** Returns true when node is a voter in config. */
export function isVoter(config: ClusterConfig, nodeId: NodeId): boolean {
  return config.voters.some((m) => m.id === nodeId);
}

/** Returns true when node is a learner in config. */
export function isLearner(config: ClusterConfig, nodeId: NodeId): boolean {
  return config.learners.some((m) => m.id === nodeId);
}

/** Returns true when node is either voter or learner in config. */
export function isNodeInCluster(config: ClusterConfig, nodeId: NodeId): boolean {
  return isVoter(config, nodeId) || isLearner(config, nodeId);
}

/** Returns majority quorum size for current voter set. */
export function getQuorumSize(config: ClusterConfig): number {
  return Math.floor(config.voters.length / 2) + 1;
}
