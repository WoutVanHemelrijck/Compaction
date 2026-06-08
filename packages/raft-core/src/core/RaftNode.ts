// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { NodeId, RaftConfig, validateConfig } from './Config';
import { Command, LogEntry, LogEntryType } from '../log/LogEntry';
import { RaftState } from './StateMachine';
import { PersistentState } from '../state/PersistentState';
import { VolatileState } from '../state/VolatileState';
import { LogManager } from '../log/LogManager';
import { StateMachine } from './StateMachine';
import { RPCHandler } from '../rpc/RPCHandler';
import { TimerManager } from '../timing/TimerManager';
import { ConsoleLogger, Logger } from '../util/Logger';
import { Random, SystemRandom } from '../util/Random';
import { Clock, SystemClock } from '../timing/Clock';
import { NodeStorage } from '../storage/interfaces/NodeStorage';
import { Transport } from '../transport/Transport';
import { RaftError } from '../util/Error';
import { AsyncLock } from '../lock/AsyncLock';
import { RaftEventBus } from '../events/RaftEvents';
import { NoOpEventBus } from '../events/EventBus';
import { SnapshotManager } from '../snapshot/SnapshotManager';
import { ConfigManager } from '../config/ConfigManager';
import { ClusterConfig, ClusterMember } from '../config/ClusterConfig';

/**
 * Result returned by command submission APIs.
 */
export interface CommandResult {
  /** Indicates whether the operation completed successfully. */
  success: boolean;
  /** Index where the command was appended or committed when available. */
  index?: number;
  /** Current known leader when the receiver is not leader. */
  leaderId?: NodeId;
  /** Human-readable reason for failure when success is false. */
  error?: string;
}

/**
 * Application state machine contract used by the Raft node.
 *
 * @remarks
 * Implementations must be deterministic for replicated commands in order to keep
 * state consistent across all nodes.
 */
export interface ApplicationStateMachine {
  /** Applies a replicated command to application state. */
  apply(command: Command): Promise<unknown>;
  /** Returns an observable view of the current application state. */
  getState(): unknown;
  /** Serializes current application state into snapshot bytes. */
  takeSnapshot(): Promise<Buffer>;
  /** Replaces current application state from snapshot bytes. */
  installSnapshot(data: Buffer): Promise<void>;
}

/**
 * Public operational interface of a Raft node.
 */
export interface RaftNodeInterface {
  start(): Promise<void>;
  stop(): Promise<void>;
  submitCommand(command: Command): Promise<CommandResult>;
  getState(): RaftState;
  isLeader(): boolean;
  getLeaderId(): NodeId | null;
  getCurrentTerm(): number;
  getCommittedIndex(): number;
  getLastApplied(): number;
  getLastLogIndex(): number;
  getNodeId(): NodeId;
  getApplicationState(): unknown;
  isStarted(): boolean;
  getEntries(startIndex: number, endIndex: number): Promise<LogEntry[]>;
  getPeerList(): Array<{ NodeId: NodeId; address: string }>;
  /**
   * Newly added functions
   */
  appendDropLogEntry(term: number, startIdx: number, finalIdx: number): Promise<number>;
  setNode(node: RaftNode): void;
  debug_getAllLogEntries(): Promise<LogEntry[]>;
  toggleLogger(): void;

  //
}

/**
 * Construction options for a Raft node instance.
 */
export interface RaftNodeOptions {
  /** Static local and cluster configuration. */
  config: RaftConfig;
  /** Node storage bundle for log, metadata, snapshots, and configuration. */
  storage: NodeStorage;
  /** Transport implementation used for Raft RPC communication. */
  transport: Transport;
  /** Application state machine receiving committed commands. */
  stateMachine: ApplicationStateMachine;
  /** Optional logger. Defaults to ConsoleLogger. */
  logger?: Logger;
  /** Optional event bus. Defaults to NoOpEventBus. */
  eventBus?: RaftEventBus;
  /** Internal/testing override for clock source. */
  _clock?: Clock;
  /** Internal/testing override for random source. */
  _random?: Random;
}

const DEFAULT_SNAPSHOT_THRESHOLD = 200;

/**
 * Raft node runtime coordinating storage, replication, membership, and command application.
 *
 * @remarks
 * This class owns node lifecycle and integrates all core components. Public methods
 * provide operational APIs while internal methods enforce leader checks, commit waiting,
 * and apply-loop consistency.
 */
export class RaftNode implements RaftNodeInterface {
  private config: RaftConfig;
  private nodeStorage: NodeStorage;
  private transport: Transport;
  private applicationStateMachine: ApplicationStateMachine;
  private clock: Clock;
  private random: Random;
  private bus: RaftEventBus;

  private persistentState: PersistentState;
  private volatileState: VolatileState;
  private logManager: LogManager;
  private stateMachine: StateMachine;
  private rpcHandler: RPCHandler;
  private timerManager: TimerManager;
  private logger: Logger;

  private started: boolean = false;
  private applyLoopRunning: boolean = false;

  private applyLock: AsyncLock = new AsyncLock();
  private commandLock: AsyncLock = new AsyncLock();

  private commitWaiters: Map<number, Array<(Commited: boolean) => void>> = new Map();

  private snapshotThreshold: number;
  private snapshotManager: SnapshotManager;

  private configManager: ConfigManager;
  /**
   * Creates a node with configured storage, transport, state machine, and runtime dependencies.
   *
   * @param options Complete node construction options.
   * @throws RaftError When configuration validation fails.
   */
  constructor(options: RaftNodeOptions) {
    const {
      config,
      storage,
      transport,
      stateMachine,
      logger,
      eventBus = new NoOpEventBus(),
      _clock = new SystemClock(),
      _random = new SystemRandom(),
    } = options;

    this.config = config;
    this.nodeStorage = storage;
    this.transport = transport;
    this.applicationStateMachine = stateMachine;
    this.clock = _clock;
    this.random = _random;
    this.bus = eventBus;

    validateConfig(config);
    this.snapshotThreshold = config.snapshotThreshold ?? DEFAULT_SNAPSHOT_THRESHOLD;

    this.logger = logger || new ConsoleLogger(config.nodeId, 'info');

    this.rpcHandler = new RPCHandler(config.nodeId, this.transport, this.logger, this.clock, this.bus);

    const timerConfig = {
      electionTimeoutMin: config.electionTimeoutMinMs,
      electionTimeoutMax: config.electionTimeoutMaxMs,
      heartbeatInterval: config.heartbeatIntervalMs,
    };

    this.timerManager = new TimerManager(this.clock, this.random, this.logger, timerConfig);

    this.persistentState = new PersistentState(this.nodeStorage.meta);

    this.volatileState = new VolatileState();

    this.logManager = new LogManager(this.nodeStorage.log, this.bus, config.nodeId);

    this.snapshotManager = new SnapshotManager(this.nodeStorage.snapshot);

    const bootstrapConfig: ClusterConfig = {
      voters: [
        { id: config.nodeId, address: config.address },
        ...config.peers.map((peer) => ({ id: peer.id, address: peer.address })),
      ],
      learners: [],
    };

    this.configManager = new ConfigManager(this.nodeStorage.config, bootstrapConfig);

    this.stateMachine = new StateMachine(
      config.nodeId,
      this.configManager,
      config,
      this.persistentState,
      this.volatileState,
      this.logManager,
      this.snapshotManager,
      this.applicationStateMachine,
      this.rpcHandler,
      this.timerManager,
      this.logger,
      this.applyLock,
      (newCommitIndex) => this.notifyCommitWaiters(newCommitIndex),
      this.bus,
      (peerId) => {
        const address = this.configManager.getMemberAddress(peerId);
        if (address) {
          void this.transport.addPeer?.(peerId, address);
        }
      },
    );
  }

  //
  setNode(node: RaftNode): void {
    this.stateMachine.setNode(node);
  }

  /**
   * Starts node services and restores persisted state.
   *
   * @remarks
   * Startup opens storage, initializes persistent/log/snapshot/config managers,
   * restores snapshot state when present, wires transport handlers, starts the
   * state machine, and launches the apply loop.
   *
   * @throws RaftError When node is already started.
   * @throws RaftError When any startup phase fails.
   */
  async start(): Promise<void> {
    if (this.started) {
      throw new RaftError(`Node ${this.config.nodeId} is already started`, 'NodeAlreadyStarted');
    }

    this.volatileState.reset();

    this.logger.info(`Starting Raft node ${this.config.nodeId}`);

    try {
      if (!this.nodeStorage.isOpen()) {
        await this.nodeStorage.open();
      }

      await this.persistentState.initialize();

      const restoredTerm = this.persistentState.getCurrentTerm();
      const restoredVotedFor = this.persistentState.getVotedFor();

      this.logger.info(
        `Node ${this.config.nodeId} initialized with term ${restoredTerm} and votedFor ${restoredVotedFor}`,
      );

      await this.logManager.initialize();

      const lastLogIndex = this.logManager.getLastIndex();
      const lastLogTerm = this.logManager.getLastTerm();

      // [DEBUG]

      //

      this.logger.info(
        `Node ${this.config.nodeId} log initialized with last index ${lastLogIndex} and last term ${lastLogTerm}`,
      );

      await this.snapshotManager.initialize();

      await this.configManager.initialize();

      const snapshot = await this.snapshotManager.loadSnapshot();

      if (snapshot) {
        if (snapshot.config.voters.length > 0) {
          this.configManager.applyConfigEntry(snapshot.config);
          await this.configManager.commitConfig(snapshot.config);
          this.logger.info(
            `Node ${this.config.nodeId} loaded cluster configuration from snapshot: voters=${snapshot.config.voters.map((m) => m.id).join(',')}, learners=${snapshot.config.learners.map((m) => m.id).join(',')}`,
          );
        }
        await this.applicationStateMachine.installSnapshot(snapshot.data);
        this.volatileState.setCommitIndex(snapshot.lastIncludedIndex);
        this.volatileState.setLastApplied(snapshot.lastIncludedIndex);
        this.logger.info(
          `Node ${this.config.nodeId} loaded snapshot with last included index ${snapshot.lastIncludedIndex} and term ${snapshot.lastIncludedTerm}`,
        );
        //
        console.log('snapshot found!');
        //
      } else {
        this.logger.info(`Node ${this.config.nodeId} did NOT have a snapshot to load from...`);
        console.log('no shapshot file found');
      }

      const latestLogConfig = await this.logManager.getLastConfigEntry();

      if (latestLogConfig) {
        this.configManager.applyConfigEntry(latestLogConfig);
        this.logger.info(
          `Node ${this.config.nodeId} applied cluster configuration from log entry: voters=${latestLogConfig.voters.map((m) => m.id).join(',')}, learners=${latestLogConfig.learners.map((m) => m.id).join(',')}`,
        );
      }

      if (!this.transport.isStarted()) {
        await this.transport.start();
      }

      const activeconfig = this.configManager.getActiveConfig();
      for (const member of [...activeconfig.voters, ...activeconfig.learners]) {
        if (member.id !== this.config.nodeId) {
          await this.transport.addPeer?.(member.id, member.address);
        }
      }

      this.transport.onMessage(async (from, message) => {
        return await this.rpcHandler.handleIncomingMessage(from, message, {
          onRequestVote: async (request, from) => {
            return await this.stateMachine.handleRequestVote(request, from);
          },

          onAppendEntries: async (request, from) => {
            return await this.stateMachine.handleAppendEntries(request, from);
          },

          onInstallSnapshot: async (from, request) => {
            return await this.stateMachine.handleInstallSnapshot(from, request);
          },
        });
      });

      await this.stateMachine.start();

      this.startApplyLoop();

      this.started = true;
      this.logger.info(`Node ${this.config.nodeId} started successfully`);

      this.bus.emit({
        eventId: crypto.randomUUID(),
        timestamp: performance.now(),
        wallTime: Date.now(),
        nodeId: this.config.nodeId,
        type: 'NodeRecovered',
        term: restoredTerm,
        logLength: lastLogIndex,
        commitIndex: this.volatileState.getCommitIndex(),
        snapshotIndex: this.logManager.getSnapshotIndex(),
      });
    } catch (error) {
      this.logger.error(`Failed to start node ${this.config.nodeId}`, { error });
      throw new RaftError(`Failed to start node: ${(error as Error).message}`, 'NodeStartFailed');
    }
  }

  /**
   * Stops node services and releases runtime resources.
   *
   * @throws RaftError When node is not started.
   * @throws RaftError When shutdown fails.
   */
  async stop(): Promise<void> {
    if (!this.started) {
      throw new RaftError(`Node ${this.config.nodeId} is not started`, 'NodeNotStarted');
    }

    this.logger.info(`Stopping Raft node ${this.config.nodeId}`);

    try {
      this.stopApplyLoop();

      await this.stateMachine.stop();

      if (this.transport.isStarted()) {
        await this.transport.stop();
      }

      if (this.nodeStorage.isOpen()) {
        await this.nodeStorage.close();
      }

      this.started = false;
      this.logger.info(`Node ${this.config.nodeId} stopped successfully`);

      this.bus.emit({
        eventId: crypto.randomUUID(),
        timestamp: performance.now(),
        wallTime: Date.now(),
        nodeId: this.config.nodeId,
        type: 'NodeCrashed',
        reason: 'stopped',
      });
    } catch (error) {
      this.logger.error(`Failed to stop node ${this.config.nodeId}`, { error });
      throw new RaftError(`Failed to stop node: ${(error as Error).message}`, 'NodeStopFailed');
    }
  }

  /**
   * Submits a client command through the leader path and waits for commit.
   *
   * @param command Command payload to replicate.
   * @returns Submission result containing success/failure details.
   */
  async submitCommand(command: Command): Promise<CommandResult> {
    const appendResult = await this.commandLock.runExclusive(async () => {
      if (!this.started) {
        return { success: false, error: 'Node is not started' };
      }

      if (!this.stateMachine.isLeader()) {
        return { success: false, leaderId: this.stateMachine.getCurrentLeader() ?? undefined, error: 'Not the leader' };
      }

      try {
        const term = this.persistentState.getCurrentTerm();

        const idx = await this.logManager.appendCommand(command, term);

        if (!this.stateMachine.isLeader() || this.persistentState.getCurrentTerm() !== term) {
          this.logger.warn(
            `Node ${this.config.nodeId} is no longer the leader or term has changed after appending command. Current term: ${this.persistentState.getCurrentTerm()}, expected term: ${term}`,
          );
          return {
            success: false,
            leaderId: this.stateMachine.getCurrentLeader() ?? undefined,
            error: 'Not the leader or term has changed',
          };
        }

        this.logger.info(`Leader ${this.config.nodeId} appended command to log at index ${idx} for term ${term}`);

        return { success: true, index: idx, term: term };
      } catch (error) {
        this.logger.error(`Error appending command to log`, { error });
        return { success: false, error: (error as Error).message };
      }
    });

    if (!appendResult.success) {
      return appendResult;
    }
    const { index: idx, term } = appendResult;

    try {
      await this.triggerReplication();

      if (!this.stateMachine.isLeader() || this.persistentState.getCurrentTerm() !== term!) {
        this.logger.warn(
          `Node ${this.config.nodeId} is no longer the leader or term has changed after triggering replication. Current term: ${this.persistentState.getCurrentTerm()}, expected term: ${term}`,
        );
        return {
          success: false,
          leaderId: this.stateMachine.getCurrentLeader() ?? undefined,
          error: 'Not the leader or term has changed',
        };
      }

      const committed = await this.waitForCommit(idx!, 5000, term);

      if (committed) {
        this.logger.info(`Command at index ${idx} committed successfully`);
        return { success: true, index: idx };
      } else {
        this.logger.warn(`Command at index ${idx} failed to commit within timeout`);
        return { success: false, error: 'Failed to commit command within timeout' };
      }
    } catch (error) {
      this.logger.error(`Error submitting command`, { error });
      return { success: false, error: (error as Error).message };
    }
  }

  /** Returns the node's current Raft role/state. */
  getState(): RaftState {
    return this.stateMachine.getCurrentState();
  }

  /** Returns true when this node currently acts as leader. */
  isLeader(): boolean {
    return this.stateMachine.isLeader();
  }

  /** Returns the known leader identifier, or null if currently unknown. */
  getLeaderId(): NodeId | null {
    return this.stateMachine.getCurrentLeader();
  }

  /** Returns the current persisted term. */
  getCurrentTerm(): number {
    return this.persistentState.getCurrentTerm();
  }

  /** Returns the highest commit index known by this node. */
  getCommittedIndex(): number {
    return this.volatileState.getCommitIndex();
  }

  /** Returns the highest log index applied to the application state machine. */
  getLastApplied(): number {
    return this.volatileState.getLastApplied();
  }

  /** Returns the highest log index currently stored. */
  getLastLogIndex(): number {
    return this.logManager.getLastIndex();
  }

  /** Returns this node identifier. */
  getNodeId(): NodeId {
    return this.config.nodeId;
  }

  /** Returns the current application state machine state projection. */
  getApplicationState(): unknown {
    return this.applicationStateMachine.getState();
  }

  /** Returns true when lifecycle start completed and stop has not been called. */
  isStarted(): boolean {
    return this.started;
  }

  /**
   * Reads a range of log entries.
   *
   * @param startIndex Inclusive start index.
   * @param endIndex Inclusive end index.
   * @returns Entries in the requested index range.
   */
  async getEntries(startIndex: number, endIndex: number): Promise<LogEntry[]> {
    return await this.logManager.getEntries(startIndex, endIndex);
  }

  async debug_getAllLogEntries(): Promise<LogEntry[]> {
    return await this.logManager.debug_getAllLogEntries();
  }

  // Includes the node itself.
  getPeerList(): Array<{ NodeId: NodeId; address: string }> {
    const activeConfig = this.configManager.getActiveConfig();
    return [...activeConfig.voters, ...activeConfig.learners].map((m) => ({ NodeId: m.id, address: m.address }));
  }

  async appendDropLogEntry(term: number, startIdx: number, finalIdx: number): Promise<number> {
    return await this.logManager.appendDropLogEntry(term, startIdx, finalIdx);
  }

  toggleLogger(): void {
    this.logger.toggle();
  }

  /**
   *
   */
  getMembers(): ClusterMember[] {
    return this.configManager.getAllMembers();
  }

  /** Starts the background loop that applies committed entries in order. */
  private startApplyLoop(): void {
    if (this.applyLoopRunning) {
      return;
    }

    this.applyLoopRunning = true;

    const runApplyLoop = async () => {
      while (this.applyLoopRunning) {
        try {
          await this.applyCommittedEntries();
        } catch (error) {
          if (error instanceof RaftError && error.code === 'ApplyEntryFailed') {
            this.logger.error(`Failed to apply log entry, stopping node to prevent inconsistency`, { error });
            this.applyLoopRunning = false;

            this.bus.emit({
              eventId: crypto.randomUUID(),
              timestamp: performance.now(),
              wallTime: Date.now(),
              nodeId: this.config.nodeId,
              type: 'FatalError',
              reason: 'ApplyEntryFailed',
              error: (error as Error).message,
            });
            this.started = false;
          }
          this.logger.error(`Error in apply loop`, { error });
        }

        await new Promise<void>((resolve) => this.clock.setTimeout(() => resolve(), 10));
      }
    };

    void runApplyLoop();
  }

  /** Stops the background apply loop at the next loop boundary. */
  private stopApplyLoop(): void {
    this.applyLoopRunning = false;
  }

  /**
   * Applies committed but not-yet-applied entries to the application state machine.
   *
   * @remarks
   * Application is serialized by applyLock to preserve strict in-order behavior.
   * Snapshot-covered ranges are skipped and lastApplied is advanced accordingly.
   *
   * @throws RaftError When applying an entry fails.
   */
  private async applyCommittedEntries(): Promise<void> {
    await this.applyLock.runExclusive(async () => {
      while (true) {
        const lastApplied = this.volatileState.getLastApplied();
        const commitIndex = this.volatileState.getCommitIndex();

        if (lastApplied >= commitIndex) {
          break;
        }

        const nextIndex = lastApplied + 1;

        const snapshotIndex = this.logManager.getSnapshotIndex();
        if (nextIndex <= snapshotIndex) {
          this.volatileState.setLastApplied(snapshotIndex);
          this.logger.info(
            `Skipping applying log entries up to index ${snapshotIndex} since they are included in the snapshot`,
          );
          continue;
        }

        const entry = await this.logManager.getEntry(nextIndex);
        if (!entry) {
          this.logger.error(`Failed to retrieve log entry at index ${nextIndex} for application`);
          break;
        }

        if (entry.index !== nextIndex) {
          this.logger.error(
            `Log entry index mismatch at index ${nextIndex}. Expected ${nextIndex} but got ${entry.index}`,
          );
          break;
        }

        try {
          if (entry.type === LogEntryType.CONFIG) {
            this.logger.info('skipping CONFIG entry');
          } else if (entry.type === LogEntryType.NOOP) {
            this.logger.info('skipping NOOP entry');
          } else if (entry.type === LogEntryType.COMMAND) {
            const result = await this.applicationStateMachine.apply(entry.command!);
            this.logger.info(
              `Applied log entry at index ${nextIndex} with command ${JSON.stringify(entry.command)}, result: ${JSON.stringify(result)}`,
            );
          } else {
            //
            console.log(await this.logManager.debug_getAllLogEntries());
            console.log('dropping log entries...');
            try {
              await this.takeSnapshot();
            } catch (err) {
              console.log(err);
            }
            //
          }

          this.volatileState.setLastApplied(nextIndex);

          const currentLastApplied = this.volatileState.getLastApplied();
          const lastSnapshotIndex = this.snapshotManager.getSnapshotMetadata()?.lastIncludedIndex ?? 0;

          if (currentLastApplied - lastSnapshotIndex >= this.snapshotThreshold) {
            await this.takeSnapshot();
          }
        } catch (error) {
          this.logger.error(
            `Error applying log entry at index ${nextIndex} with command ${JSON.stringify(entry.command)}`,
            { error },
          );

          throw new RaftError(
            `Failed to apply log entry at index ${nextIndex}: ${(error as Error).message}`,
            'ApplyEntryFailed',
          );
        }
      }
    });
  }

  /** Triggers replication if and only if this node is currently leader. */
  private async triggerReplication(): Promise<void> {
    if (this.stateMachine.isLeader()) {
      await this.stateMachine.triggerReplication();
    }
  }

  /**
   * Proposes adding a node to cluster membership.
   *
   * @param nodeId Node identifier to add.
   * @param address Transport address for the new node.
   * @param asLearner When true, adds the node as learner instead of voter.
   * @returns True when configuration change is committed.
   */
  async addServer(nodeId: NodeId, address: string, asLearner: boolean = false): Promise<boolean> {
    if (!this.started) {
      this.logger.warn(`Node ${this.config.nodeId} is not started, cannot add server ${nodeId}`);
      return false;
    }

    if (!this.stateMachine.isLeader()) {
      this.logger.warn(`Node ${this.config.nodeId} is not the leader, cannot add server ${nodeId}`);
      return false;
    }

    if (this.configManager.hasPendingChange()) {
      this.logger.warn(
        `Node ${this.config.nodeId} already has a pending configuration change, cannot add server ${nodeId} until it is committed`,
      );
      return false;
    }

    const currentConfig = this.configManager.getActiveConfig();
    if (currentConfig.voters.some((m) => m.id === nodeId) || currentConfig.learners.some((m) => m.id === nodeId)) {
      this.logger.warn(`Node ${nodeId} is already part of the cluster configuration, cannot add again`);
      return false;
    }

    await this.transport.addPeer?.(nodeId, address);

    const newConfig: ClusterConfig = asLearner
      ? { voters: currentConfig.voters, learners: [...currentConfig.learners, { id: nodeId, address: address }] }
      : { voters: [...currentConfig.voters, { id: nodeId, address: address }], learners: currentConfig.learners };

    const result = await this.submitConfigChange(newConfig);

    this.logger.info(`Initiated adding server ${nodeId} as ${asLearner ? 'learner' : 'voter'} to the cluster`);

    if (result) {
      this.bus.emit({
        eventId: crypto.randomUUID(),
        timestamp: performance.now(),
        wallTime: Date.now(),
        nodeId: this.config.nodeId,
        type: 'ServerAdded',
        addedNodeId: nodeId,
        asLearner: asLearner,
        config: this.configManager.getCommittedConfig(),
      });
    } else {
      this.bus.emit({
        eventId: crypto.randomUUID(),
        timestamp: performance.now(),
        wallTime: Date.now(),
        nodeId: this.config.nodeId,
        type: 'ConfigChangeRejected',
        voters: newConfig.voters,
        learners: newConfig.learners,
        reason: 'Failed to commit configuration change',
      });
    }
    return result;
  }

  /**
   * Proposes removing a node from cluster membership.
   *
   * @param nodeId Node identifier to remove.
   * @returns True when configuration change is committed.
   */
  async removeServer(nodeId: NodeId): Promise<boolean> {
    if (!this.started) {
      this.logger.warn(`Node ${this.config.nodeId} is not started, cannot remove server ${nodeId}`);
      return false;
    }

    if (!this.stateMachine.isLeader()) {
      this.logger.warn(`Node ${this.config.nodeId} is not the leader, cannot remove server ${nodeId}`);
      return false;
    }

    if (this.configManager.hasPendingChange()) {
      this.logger.warn(
        `Node ${this.config.nodeId} already has a pending configuration change, cannot remove server ${nodeId} until it is committed`,
      );
      return false;
    }

    const currentConfig = this.configManager.getActiveConfig();
    if (!currentConfig.voters.some((m) => m.id === nodeId) && !currentConfig.learners.some((m) => m.id === nodeId)) {
      this.logger.warn(`Node ${nodeId} is not part of the cluster configuration, cannot remove`);
      return false;
    }

    if (currentConfig.voters.some((m) => m.id === nodeId) && currentConfig.voters.length <= 2) {
      this.logger.warn(`Cannot remove voter ${nodeId} since it would leave the cluster with less than 2 voters`);
      return false;
    }

    const newConfig: ClusterConfig = {
      voters: currentConfig.voters.filter((m) => m.id !== nodeId),
      learners: currentConfig.learners.filter((m) => m.id !== nodeId),
    };

    const result = await this.submitConfigChange(newConfig);

    if (result) {
      this.transport.removePeer?.(nodeId);

      this.bus.emit({
        eventId: crypto.randomUUID(),
        timestamp: performance.now(),
        wallTime: Date.now(),
        nodeId: this.config.nodeId,
        type: 'ServerRemoved',
        removedNodeId: nodeId,
        config: this.configManager.getCommittedConfig(),
      });
    }

    return result;
  }

  /**
   * Proposes promoting a learner to voter.
   *
   * @param nodeId Learner node identifier.
   * @returns True when configuration change is committed.
   */
  async promoteServer(nodeId: NodeId): Promise<boolean> {
    if (!this.started) {
      this.logger.warn(`Node ${this.config.nodeId} is not started, cannot promote server ${nodeId}`);
      return false;
    }

    if (!this.stateMachine.isLeader()) {
      this.logger.warn(`Node ${this.config.nodeId} is not the leader, cannot promote server ${nodeId}`);
      return false;
    }

    if (this.configManager.hasPendingChange()) {
      this.logger.warn(
        `Node ${this.config.nodeId} already has a pending configuration change, cannot promote server ${nodeId} until it is committed`,
      );
      return false;
    }

    const currentConfig = this.configManager.getActiveConfig();
    if (!currentConfig.learners.some((m) => m.id === nodeId)) {
      this.logger.warn(`Node ${nodeId} is not a learner, cannot promote`);
      return false;
    }

    const memberToPromote = currentConfig.learners.find((m) => m.id === nodeId)!;

    const newConfig: ClusterConfig = {
      voters: [...currentConfig.voters, memberToPromote],
      learners: currentConfig.learners.filter((m) => m.id !== nodeId),
    };

    const result = await this.submitConfigChange(newConfig);

    this.logger.info(`Initiated promoting server ${nodeId} to voter`);

    if (result) {
      this.bus.emit({
        eventId: crypto.randomUUID(),
        timestamp: performance.now(),
        wallTime: Date.now(),
        nodeId: this.config.nodeId,
        type: 'LearnerPromoted',
        promotedNodeId: nodeId,
        config: this.configManager.getCommittedConfig(),
      });
    }
    return result;
  }

  /**
   * Adds a transport peer without changing cluster configuration.
   *
   * @param nodeId Peer node identifier.
   * @param address Peer transport address.
   */
  async registerPeer(nodeId: NodeId, address: string): Promise<void> {
    await this.transport.addPeer?.(nodeId, address);
  }

  /**
   * Removes a transport peer without changing cluster configuration.
   *
   * @param nodeId Peer node identifier.
   */
  removePeer(nodeId: NodeId): Promise<void> {
    this.transport.removePeer?.(nodeId);
    return Promise.resolve();
  }

  /**
   * Appends and commits a cluster configuration entry.
   *
   * @param newConfig Configuration to append and attempt to commit.
   * @returns True when the configuration entry commits in the current leader term.
   */
  private async submitConfigChange(newConfig: ClusterConfig): Promise<boolean> {
    let capturedIndex: number | null = null;
    let capturedTerm: number | null = null;

    const appendResult = await this.commandLock.runExclusive(async () => {
      const term = this.persistentState.getCurrentTerm();
      const idx = await this.logManager.appendConfigEntry(newConfig, term);
      this.configManager.applyConfigEntry(newConfig);

      this.bus.emit({
        eventId: crypto.randomUUID(),
        timestamp: performance.now(),
        wallTime: Date.now(),
        nodeId: this.config.nodeId,
        type: 'ConfigChanged',
        voters: newConfig.voters,
        learners: newConfig.learners,
        commited: false,
      });

      if (!this.stateMachine.isLeader() || this.persistentState.getCurrentTerm() !== term) {
        this.logger.warn(
          `Node ${this.config.nodeId} is no longer the leader or term has changed after appending config entry. Current term: ${this.persistentState.getCurrentTerm()}, expected term: ${term}`,
        );
        return false;
      }

      capturedIndex = idx;
      capturedTerm = term;

      return true;
    });

    if (!appendResult || capturedIndex === null || capturedTerm === null) {
      return false;
    }

    await this.triggerReplication();

    const committed = await this.waitForCommit(capturedIndex, 5000, capturedTerm);

    if (committed) {
      this.bus.emit({
        eventId: crypto.randomUUID(),
        timestamp: performance.now(),
        wallTime: Date.now(),
        nodeId: this.config.nodeId,
        type: 'ConfigChanged',
        voters: newConfig.voters,
        learners: newConfig.learners,
        commited: true,
      });
    }

    return committed;
  }

  /**
   * Waits for an index to commit while leadership and term remain valid.
   *
   * @param index Log index to wait for.
   * @param timeoutMs Maximum wait duration in milliseconds.
   * @param term Leader term captured when the entry was appended.
   * @returns True if committed before timeout and before losing leadership/term.
   */
  private async waitForCommit(index: number, timeoutMs: number, term: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const startTime = this.clock.now();

      if (this.volatileState.getCommitIndex() >= index) {
        resolve(true);
        return;
      }

      if (!this.commitWaiters.has(index)) {
        this.commitWaiters.set(index, []);
      }

      const callback = (committed: boolean) => {
        resolve(committed);
      };

      this.commitWaiters.get(index)!.push(callback);

      const timeoutHandle = this.clock.setTimeout(() => {
        const waiters = this.commitWaiters.get(index);
        if (waiters) {
          const idx = waiters.indexOf(callback);
          if (idx !== -1) {
            waiters.splice(idx, 1);
          }
          if (waiters.length === 0) {
            this.commitWaiters.delete(index);
          }
        }

        const committed = this.volatileState.getCommitIndex() >= index;
        resolve(committed);
      }, timeoutMs);

      const checkLeadership = () => {
        if (!this.stateMachine.isLeader() || this.persistentState.getCurrentTerm() !== term) {
          this.clock.clearTimeout(timeoutHandle);

          const waiters = this.commitWaiters.get(index);
          if (waiters) {
            const idx = waiters.indexOf(callback);
            if (idx !== -1) {
              waiters.splice(idx, 1);
            }
          }

          resolve(false);
          return;
        }

        if (this.clock.now() - startTime < timeoutMs) {
          this.clock.setTimeout(checkLeadership, 100);
        }
      };

      this.clock.setTimeout(checkLeadership, 100);
    });
  }

  /**
   * Resolves pending commit waiters at or below the provided commit index.
   *
   * @param newCommitIndex Latest committed index.
   */
  private notifyCommitWaiters(newCommitIndex: number): void {
    for (const [index, resolvers] of this.commitWaiters.entries()) {
      if (index <= newCommitIndex) {
        resolvers.forEach((resolve) => resolve(true));
        this.commitWaiters.delete(index);
      }
    }
  }

  /**
   * Captures a new snapshot and compacts log entries up to lastApplied.
   *
   * @remarks
   * Snapshot metadata includes committed cluster configuration to ensure cluster
   * membership can be reconstructed during recovery.
   */
  private async takeSnapshot(): Promise<void> {
    const snapshotIndex = this.volatileState.getLastApplied();
    const snapshotTerm = await this.logManager.getTermAtIndex(snapshotIndex);

    if (snapshotTerm === null) {
      this.logger.error(`Failed to get term for snapshot index ${snapshotIndex}, skipping snapshot`);
      return;
    }

    const data = await this.applicationStateMachine.takeSnapshot();

    await this.snapshotManager.saveSnapshot({
      lastIncludedIndex: snapshotIndex,
      lastIncludedTerm: snapshotTerm,
      data: data,
      config: this.configManager.getCommittedConfig(),
    });

    await this.logManager.discardEntriesUpTo(snapshotIndex, snapshotTerm);

    this.logger.info(
      `Took snapshot at index ${snapshotIndex} and term ${snapshotTerm}, discarded log entries up to index ${snapshotIndex}`,
    );

    this.bus.emit({
      eventId: crypto.randomUUID(),
      timestamp: performance.now(),
      wallTime: Date.now(),
      nodeId: this.config.nodeId,
      type: 'SnapshotTaken',
      lastIncludedIndex: snapshotIndex,
      lastIncludedTerm: snapshotTerm,
      snapshotSizeBytes: data.length,
    });
  }
}
