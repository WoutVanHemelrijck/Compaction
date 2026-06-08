// @author Mathias Bouhon Keulen
// @date 2026-03-20
/**
 * Base typed error for raft-core with stable machine-readable error code.
 */
export class RaftError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'RaftError';
    Object.setPrototypeOf(this, RaftError.prototype); // anders kapotte prototype chain, blijkbaar niet meer nodig in ES2015+ maar nodig in ES5
  }
}

/** Raised when an operation requires leadership but node is not leader. */
export class NotLeaderError extends RaftError {
  constructor(public readonly leaderId: string | null) {
    super(
      leaderId ? `Not the leader. Current leader is ${leaderId}.` : 'Not the leader. No leader currently known.',
      'NOT_LEADER',
    );
    this.name = 'NotLeaderError';
    Object.setPrototypeOf(this, NotLeaderError.prototype);
  }
}

/** Raised on replicated log invariant violations. */
export class LogInconsistencyError extends RaftError {
  constructor(message: string) {
    super(message, 'LOG_INCONSISTENCY');
    this.name = 'LogInconsistencyError';
    Object.setPrototypeOf(this, LogInconsistencyError.prototype);
  }
}

/** Raised for storage operation failures. */
export class StorageError extends RaftError {
  constructor(
    message: string,
    public readonly cause?: Error,
  ) {
    super(message, 'STORAGE_ERROR');
    this.name = 'StorageError';
    Object.setPrototypeOf(this, StorageError.prototype);
  }
}

/** Raised for transport/network failures. */
export class NetworkError extends RaftError {
  constructor(
    message: string,
    public readonly cause?: Error,
  ) {
    super(message, 'NETWORK_ERROR');
    this.name = 'NetworkError';
    Object.setPrototypeOf(this, NetworkError.prototype);
  }
}

/** Raised when observed term differs from expected term. */
export class TermMismatchError extends RaftError {
  constructor(
    public readonly expectedTerm: number,
    public readonly actualTerm: number,
  ) {
    super(`Term mismatch: expected ${expectedTerm}, got ${actualTerm}`, 'TERM_MISMATCH');
    this.name = 'TermMismatchError';
    Object.setPrototypeOf(this, TermMismatchError.prototype);
  }
}

/** Raised when an operation exceeds allotted time budget. */
export class TimeoutError extends RaftError {
  constructor(
    message: string,
    public readonly cause?: Error,
  ) {
    super(message, 'TIMEOUT');
    this.name = 'TimeoutError';
    Object.setPrototypeOf(this, TimeoutError.prototype);
  }
}

/** Raised for invalid role/state transitions. */
export class InvalidStateError extends RaftError {
  constructor(
    public readonly fromState: string,
    public readonly toState: string,
  ) {
    super(`Invalid state transition: from ${fromState} to ${toState}`, 'INVALID_STATE');
    this.name = 'InvalidStateError';
    Object.setPrototypeOf(this, InvalidStateError.prototype);
  }
}

/** Raised for failures in persistent-state management. */
export class PersistentStateError extends RaftError {
  constructor(
    message: string,
    public readonly cause?: Error,
  ) {
    super(message, 'PERSISTENT_STATE_ERROR');
    this.name = 'PersistentStateError';
    Object.setPrototypeOf(this, PersistentStateError.prototype);
  }
}

/** Raised for invalid volatile-state transitions. */
export class VolatileStateError extends RaftError {
  constructor(
    message: string,
    public readonly cause?: Error,
  ) {
    super(message, 'VOLATILE_STATE_ERROR');
    this.name = 'VolatileStateError';
    Object.setPrototypeOf(this, VolatileStateError.prototype);
  }
}

/** Raised for leader replication-state handling failures. */
export class LeaderStateError extends RaftError {
  constructor(
    message: string,
    public readonly cause?: Error,
  ) {
    super(message, 'LEADER_STATE_ERROR');
    this.name = 'LeaderStateError';
    Object.setPrototypeOf(this, LeaderStateError.prototype);
  }
}

/** Raised for timer manager configuration/runtime failures. */
export class TimerManagerError extends RaftError {
  constructor(
    message: string,
    public readonly cause?: Error,
  ) {
    super(message, 'TIMER_MANAGER_ERROR');
    this.name = 'TimerManagerError';
    Object.setPrototypeOf(this, TimerManagerError.prototype);
  }
}

/** Raised for RPC handler timeout/validation failures. */
export class RPCHandlerError extends RaftError {
  constructor(
    message: string,
    public readonly cause?: Error,
  ) {
    super(message, 'RPC_HANDLER_ERROR');
    this.name = 'RPCHandlerError';
    Object.setPrototypeOf(this, RPCHandlerError.prototype);
  }
}
