// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { ClusterMember } from '../config/ClusterConfig';

/** Logical node identifier used across raft-core. */
export type NodeId = string;

/**
 * Static node bootstrap/runtime configuration.
 */
export interface RaftConfig {
  /** Local node id. */
  nodeId: NodeId;
  /** Local transport address. */
  address: string;
  /** Other cluster members (excluding self). */
  peers: ClusterMember[];
  /** Minimum election timeout in milliseconds. */
  electionTimeoutMinMs: number;
  /** Maximum election timeout in milliseconds. */
  electionTimeoutMaxMs: number;
  /** Heartbeat interval in milliseconds. */
  heartbeatIntervalMs: number;
  /** Optional committed-entry threshold for triggering snapshots. */
  snapshotThreshold?: number;
}

/**
 * Validates Raft node configuration invariants.
 *
 * @param config Configuration object to validate.
 * @throws Error When any required field is invalid.
 */
export function validateConfig(config: RaftConfig): void {
  if (typeof config.nodeId !== 'string' || config.nodeId.length === 0) {
    throw new Error(`Invalid nodeId: ${config.nodeId}. nodeId must be a non-empty string.`);
  }

  if (typeof config.address !== 'string' || config.address.length === 0) {
    throw new Error(`Invalid address: ${config.address}. address must be a non-empty string.`);
  }

  if (!Array.isArray(config.peers)) {
    throw new Error(`Invalid peers: ${String(config.peers)}. peers must be an array of ClusterMember objects.`);
  }

  if (config.peers.some((peer) => typeof peer.id !== 'string' || typeof peer.address !== 'string')) {
    throw new Error(`Invalid peers: peers must contain objects with string id and address.`);
  }

  if (config.peers.some((peer) => peer.id === config.nodeId)) {
    throw new Error(`Invalid peers: peers cannot include the nodeId.`);
  }

  if (!Number.isInteger(config.electionTimeoutMinMs) || config.electionTimeoutMinMs <= 0) {
    throw new Error(
      `Invalid electionTimeoutMinMs: ${config.electionTimeoutMinMs}. electionTimeoutMinMs must be a positive integer.`,
    );
  }

  if (!Number.isInteger(config.electionTimeoutMaxMs) || config.electionTimeoutMaxMs <= 0) {
    throw new Error(
      `Invalid electionTimeoutMaxMs: ${config.electionTimeoutMaxMs}. electionTimeoutMaxMs must be a positive integer.`,
    );
  }

  if (config.electionTimeoutMinMs >= config.electionTimeoutMaxMs) {
    throw new Error(
      `Invalid election timeout range: min ${config.electionTimeoutMinMs} ms must be less than max ${config.electionTimeoutMaxMs} ms.`,
    );
  }

  if (!Number.isInteger(config.heartbeatIntervalMs) || config.heartbeatIntervalMs <= 0) {
    throw new Error(
      `Invalid heartbeatIntervalMs: ${config.heartbeatIntervalMs}. heartbeatIntervalMs must be a positive integer.`,
    );
  }

  if (config.electionTimeoutMinMs < config.heartbeatIntervalMs * 3) {
    throw new Error(
      `Invalid electionTimeoutMinMs: ${config.electionTimeoutMinMs}. electionTimeoutMinMs must be at least three times the heartbeatIntervalMs: ${config.heartbeatIntervalMs}.`,
    );
  }

  if (
    config.snapshotThreshold !== undefined &&
    (!Number.isInteger(config.snapshotThreshold) || config.snapshotThreshold <= 0)
  ) {
    throw new Error(
      `Invalid snapshotThreshold: ${config.snapshotThreshold}. snapshotThreshold must be a positive integer.`,
    );
  }
}

/**
 * Creates and validates a Raft configuration object.
 *
 * @returns Validated RaftConfig instance.
 * @throws Error When provided values violate config invariants.
 */
export function createConfig(
  nodeId: NodeId,
  address: string,
  peers: ClusterMember[],
  electionTimeoutMinMs: number,
  electionTimeoutMaxMs: number,
  heartbeatIntervalMs: number,
  snapshotThreshold?: number,
): RaftConfig {
  const config: RaftConfig = {
    nodeId,
    address,
    peers,
    electionTimeoutMinMs,
    electionTimeoutMaxMs,
    heartbeatIntervalMs,
    ...(snapshotThreshold !== undefined ? { snapshotThreshold } : {}),
  };
  validateConfig(config);
  return config;
}
