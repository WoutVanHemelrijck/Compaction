// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { NodeId } from '../core/Config';
import { ConfigStorage } from '../storage/interfaces/ConfigStorage';
import { StorageError } from '../util/Error';
import { ClusterConfig, clusterConfigsEqual, ClusterMember, getQuorumSize, isLearner, isVoter } from './ClusterConfig';

/**
 * Cluster configuration management contract.
 */
export interface ConfigManagerInterface {
  applyConfigEntry(config: ClusterConfig): void;
  commitConfig(config: ClusterConfig): Promise<void>;
  getActiveConfig(): ClusterConfig;
  getCommittedConfig(): ClusterConfig;
  getVoters(): NodeId[];
  getLearners(): NodeId[];
  getAllPeers(selfId: NodeId): NodeId[];
  getQuorumSize(): number;
  isVoter(nodeId: NodeId): boolean;
  isLearner(nodeId: NodeId): boolean;
  hasPendingChange(): boolean;
}

/**
 * Manages active and committed cluster configurations with persistent storage backing.
 *
 * @remarks
 * Active config tracks the latest configuration seen in the log, which may include
 * an uncommitted joint configuration. Committed config reflects the last durably
 * stored configuration and is the source of truth for quorum and membership queries.
 */
export class ConfigManager implements ConfigManagerInterface {
  private activeConfig: ClusterConfig;
  private committedConfig: ClusterConfig;
  private initialized: boolean = false;

  constructor(
    private readonly configStorage: ConfigStorage,
    initialConfig: ClusterConfig,
  ) {
    this.activeConfig = initialConfig;
    this.committedConfig = initialConfig;
  }

  /**
   * Loads committed configuration from storage, overriding the bootstrap config.
   *
   * @returns Persisted config when present, otherwise null.
   */
  async initialize(): Promise<ClusterConfig | null> {
    if (this.initialized) {
      return this.committedConfig;
    }

    const data = await this.configStorage.read();

    if (!data) {
      this.initialized = true;
      return null;
    }

    const persistedConfig: ClusterConfig = { voters: data.voters, learners: data.learners };
    this.activeConfig = persistedConfig;
    this.committedConfig = persistedConfig;
    this.initialized = true;

    return persistedConfig;
  }

  /**
   * Applies an uncommitted configuration entry seen in the log.
   *
   * @param config New configuration to use as active.
   */
  applyConfigEntry(config: ClusterConfig): void {
    this.ensureInitialized();
    this.activeConfig = config;
  }

  /**
   * Persists and commits a configuration when its log entry is committed.
   *
   * @param config Configuration to persist and mark as committed.
   */
  async commitConfig(config: ClusterConfig): Promise<void> {
    this.ensureInitialized();

    await this.configStorage.write(config.voters, config.learners);

    this.committedConfig = config;
  }

  /** Returns the latest seen configuration, which may be uncommitted. */
  getActiveConfig(): ClusterConfig {
    this.ensureInitialized();
    return this.activeConfig;
  }

  /** Returns the last durably committed configuration. */
  getCommittedConfig(): ClusterConfig {
    this.ensureInitialized();
    return this.committedConfig;
  }

  /** Returns node ids of all current active voters. */
  getVoters(): NodeId[] {
    this.ensureInitialized();
    return this.activeConfig.voters.map((v) => v.id);
  }

  /** Returns node ids of all current active learners. */
  getLearners(): NodeId[] {
    this.ensureInitialized();
    return this.activeConfig.learners.map((l) => l.id);
  }

  /**
   * Returns node ids of all active members except the provided self id.
   *
   * @param selfId Node id to exclude.
   * @returns Node ids of all voters and learners except self.
   */
  getAllPeers(selfId: NodeId): NodeId[] {
    this.ensureInitialized();
    return [...this.activeConfig.voters, ...this.activeConfig.learners].map((m) => m.id).filter((id) => id !== selfId);
  }

  /**
   * Returns the transport address for a given node id from the active configuration.
   *
   * @param nodeId Node to look up.
   * @returns Transport address, or null when not found.
   */
  getMemberAddress(nodeId: NodeId): string | null {
    this.ensureInitialized();
    const member = [...this.activeConfig.voters, ...this.activeConfig.learners].find((m) => m.id === nodeId);
    return member?.address ?? null;
  }

  /** Returns all active voters and learners as full ClusterMember objects. */
  getAllMembers(): ClusterMember[] {
    this.ensureInitialized();
    return [...this.activeConfig.voters, ...this.activeConfig.learners];
  }

  /** Returns the quorum size required for decisions in the active configuration. */
  getQuorumSize(): number {
    this.ensureInitialized();
    return getQuorumSize(this.activeConfig);
  }

  /**
   * Returns true when the given node is a voter in the active configuration.
   *
   * @param nodeId Node id to check.
   */
  isVoter(nodeId: NodeId): boolean {
    this.ensureInitialized();
    return isVoter(this.activeConfig, nodeId);
  }

  /**
   * Returns true when the given node is a learner in the active configuration.
   *
   * @param nodeId Node id to check.
   */
  isLearner(nodeId: NodeId): boolean {
    this.ensureInitialized();
    return isLearner(this.activeConfig, nodeId);
  }

  /** Returns true when active config differs from committed config. */
  hasPendingChange(): boolean {
    this.ensureInitialized();
    return !clusterConfigsEqual(this.activeConfig, this.committedConfig);
  }

  /** Throws if initialize() has not been called. */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new StorageError('ConfigManager is not initialized. Call initialize() before using.');
    }
  }
}
