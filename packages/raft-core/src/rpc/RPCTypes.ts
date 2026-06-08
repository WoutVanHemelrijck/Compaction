// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { NodeId } from '../core/Config';
import { LogEntry } from '../log/LogEntry';
import { ClusterConfig } from '../config/ClusterConfig';

/** RequestVote request payload. */
export interface RequestVoteRequest {
  term: number;
  candidateId: NodeId;
  lastLogIndex: number;
  lastLogTerm: number;
  preVote?: boolean;
}

/** RequestVote response payload. */
export interface RequestVoteResponse {
  term: number;
  voteGranted: boolean;
}

/** AppendEntries request payload. */
export interface AppendEntriesRequest {
  term: number;
  leaderId: NodeId;
  prevLogIndex: number;
  prevLogTerm: number;
  entries: LogEntry[]; // empty when sending heartbeat
  leaderCommit: number;
}

/** AppendEntries response payload with optional conflict hints. */
export interface AppendEntriesResponse {
  term: number;
  success: boolean;
  matchIndex?: number; // last three fields are optimization for leader upon failed append
  conflictIndex?: number;
  conflictTerm?: number;
}

/** InstallSnapshot request payload. */
export interface InstallSnapshotRequest {
  term: number;
  leaderId: NodeId;
  lastIncludedIndex: number;
  lastIncludedTerm: number;
  data: Buffer;
  config: ClusterConfig;
  offset: number;
  done: boolean;
}

/** InstallSnapshot response payload. */
export interface InstallSnapshotResponse {
  term: number;
  success: boolean;
}

/** Union of all RPC request payloads. */
export type RPCRequest = RequestVoteRequest | AppendEntriesRequest | InstallSnapshotRequest;

/** Union of all RPC response payloads. */
export type RPCResponse = RequestVoteResponse | AppendEntriesResponse | InstallSnapshotResponse;

export interface RequestVoteRequestMessage {
  type: 'RequestVote';
  direction: 'request';
  payload: RequestVoteRequest;
}

export interface RequestVoteResponseMessage {
  type: 'RequestVote';
  direction: 'response';
  payload: RequestVoteResponse;
}

export interface AppendEntriesRequestMessage {
  type: 'AppendEntries';
  direction: 'request';
  payload: AppendEntriesRequest;
}

export interface AppendEntriesResponseMessage {
  type: 'AppendEntries';
  direction: 'response';
  payload: AppendEntriesResponse;
}

export interface InstallSnapshotRequestMessage {
  type: 'InstallSnapshot';
  direction: 'request';
  payload: InstallSnapshotRequest;
}

export interface InstallSnapshotResponseMessage {
  type: 'InstallSnapshot';
  direction: 'response';
  payload: InstallSnapshotResponse;
}

/** Discriminated union of all raft RPC wire message envelopes. */
export type RPCMessage =
  | RequestVoteRequestMessage
  | RequestVoteResponseMessage
  | AppendEntriesRequestMessage
  | AppendEntriesResponseMessage
  | InstallSnapshotRequestMessage
  | InstallSnapshotResponseMessage;

/** Type guard for RequestVote request message envelope. */
export function isRequestVoteRequestMessage(message: RPCMessage): message is RequestVoteRequestMessage {
  return message.type === 'RequestVote' && message.direction === 'request';
}

/** Type guard for RequestVote response message envelope. */
export function isRequestVoteResponseMessage(message: RPCMessage): message is RequestVoteResponseMessage {
  return message.type === 'RequestVote' && message.direction === 'response';
}

/** Type guard for AppendEntries request message envelope. */
export function isAppendEntriesRequestMessage(message: RPCMessage): message is AppendEntriesRequestMessage {
  return message.type === 'AppendEntries' && message.direction === 'request';
}

/** Type guard for AppendEntries response message envelope. */
export function isAppendEntriesResponseMessage(message: RPCMessage): message is AppendEntriesResponseMessage {
  return message.type === 'AppendEntries' && message.direction === 'response';
}

/** Type guard for InstallSnapshot request message envelope. */
export function isInstallSnapshotRequestMessage(message: RPCMessage): message is InstallSnapshotRequestMessage {
  return message.type === 'InstallSnapshot' && message.direction === 'request';
}

/** Type guard for InstallSnapshot response message envelope. */
export function isInstallSnapshotResponseMessage(message: RPCMessage): message is InstallSnapshotResponseMessage {
  return message.type === 'InstallSnapshot' && message.direction === 'response';
}

/**
 * Validates RequestVote request payload.
 *
 * @throws Error When payload shape or values are invalid.
 */
export function validateRequestVoteRequest(request: RequestVoteRequest): void {
  if (!Number.isInteger(request.term) || request.term < 0) {
    throw new Error(`Invalid term: ${request.term}. term must be a non-negative integer.`);
  }

  if (!request.candidateId || typeof request.candidateId !== 'string') {
    throw new Error(`Invalid candidateId: ${request.candidateId}. candidateId must be a non-empty string.`);
  }

  if (!Number.isInteger(request.lastLogIndex) || request.lastLogIndex < 0) {
    throw new Error(`Invalid lastLogIndex: ${request.lastLogIndex}. lastLogIndex must be a non-negative integer.`);
  }

  if (!Number.isInteger(request.lastLogTerm) || request.lastLogTerm < 0) {
    throw new Error(`Invalid lastLogTerm: ${request.lastLogTerm}. lastLogTerm must be a non-negative integer.`);
  }

  if (request.preVote !== undefined && typeof request.preVote !== 'boolean') {
    throw new Error(`Invalid preVote: ${String(request.preVote)}. preVote must be a boolean if provided.`);
  }
}

/** Validates RequestVote response payload. */
export function validateRequestVoteResponse(response: RequestVoteResponse): void {
  if (!Number.isInteger(response.term) || response.term < 0) {
    throw new Error(`Invalid term: ${response.term}. term must be a non-negative integer.`);
  }

  if (typeof response.voteGranted !== 'boolean') {
    throw new Error(`Invalid voteGranted: ${String(response.voteGranted)}. voteGranted must be a boolean.`);
  }
}

/** Validates AppendEntries request payload. */
export function validateAppendEntriesRequest(request: AppendEntriesRequest): void {
  if (!Number.isInteger(request.term) || request.term < 0) {
    throw new Error(`Invalid term: ${request.term}. term must be a non-negative integer.`);
  }

  if (!request.leaderId || typeof request.leaderId !== 'string') {
    throw new Error(`Invalid leaderId: ${request.leaderId}. leaderId must be a non-empty string.`);
  }

  if (!Number.isInteger(request.prevLogIndex) || request.prevLogIndex < 0) {
    throw new Error(`Invalid prevLogIndex: ${request.prevLogIndex}. prevLogIndex must be a non-negative integer.`);
  }

  if (!Number.isInteger(request.prevLogTerm) || request.prevLogTerm < 0) {
    throw new Error(`Invalid prevLogTerm: ${request.prevLogTerm}. prevLogTerm must be a non-negative integer.`);
  }

  if (!Number.isInteger(request.leaderCommit) || request.leaderCommit < 0) {
    throw new Error(`Invalid leaderCommit: ${request.leaderCommit}. leaderCommit must be a non-negative integer.`);
  }

  if (!Array.isArray(request.entries) || request.entries.some((entry) => typeof entry !== 'object')) {
    throw new Error(
      `Invalid entries: ${JSON.stringify(request.entries)}. entries must be an array of LogEntry objects.`,
    );
  }
}

/** Validates AppendEntries response payload. */
export function validateAppendEntriesResponse(response: AppendEntriesResponse): void {
  if (!Number.isInteger(response.term) || response.term < 0) {
    throw new Error(`Invalid term: ${response.term}. term must be a non-negative integer.`);
  }

  if (typeof response.success !== 'boolean') {
    throw new Error(`Invalid success: ${String(response.success)}. success must be a boolean.`);
  }

  if (response.matchIndex !== undefined && (!Number.isInteger(response.matchIndex) || response.matchIndex < 0)) {
    throw new Error(`Invalid matchIndex: ${response.matchIndex}. matchIndex must be a non-negative integer.`);
  }

  if (
    response.conflictIndex !== undefined &&
    (!Number.isInteger(response.conflictIndex) || response.conflictIndex < 0)
  ) {
    throw new Error(`Invalid conflictIndex: ${response.conflictIndex}. conflictIndex must be a non-negative integer.`);
  }

  if (response.conflictTerm !== undefined && (!Number.isInteger(response.conflictTerm) || response.conflictTerm < 0)) {
    throw new Error(`Invalid conflictTerm: ${response.conflictTerm}. conflictTerm must be a non-negative integer.`);
  }
}

/** Validates InstallSnapshot request payload. */
export function validateInstallSnapshotRequest(request: InstallSnapshotRequest): void {
  if (!Number.isInteger(request.term) || request.term < 0) {
    throw new Error(`Invalid term: ${request.term}. term must be a non-negative integer.`);
  }

  if (!request.leaderId || typeof request.leaderId !== 'string') {
    throw new Error(`Invalid leaderId: ${request.leaderId}. leaderId must be a non-empty string.`);
  }

  if (!Number.isInteger(request.lastIncludedIndex) || request.lastIncludedIndex < 0) {
    throw new Error(
      `Invalid lastIncludedIndex: ${request.lastIncludedIndex}. lastIncludedIndex must be a non-negative integer.`,
    );
  }

  if (!Number.isInteger(request.lastIncludedTerm) || request.lastIncludedTerm < 0) {
    throw new Error(
      `Invalid lastIncludedTerm: ${request.lastIncludedTerm}. lastIncludedTerm must be a non-negative integer.`,
    );
  }

  if (!Buffer.isBuffer(request.data)) {
    throw new Error(`Invalid data: ${String(request.data)}. data must be a Buffer.`);
  }

  if (!Number.isInteger(request.offset) || request.offset < 0) {
    throw new Error(`Invalid offset: ${String(request.offset)}. offset must be a non-negative integer.`);
  }

  if (typeof request.done !== 'boolean') {
    throw new Error(`Invalid done: ${String(request.done)}. done must be a boolean.`);
  }

  if (!request.config || typeof request.config !== 'object') {
    throw new Error(`Invalid config: ${String(request.config)}. config must be an object.`);
  }

  if (!Array.isArray(request.config.voters) || !Array.isArray(request.config.learners)) {
    throw new Error(`Invalid config: ${JSON.stringify(request.config)}. voters and learners must be arrays.`);
  }

  if (
    request.config.voters.some((m: unknown) => {
      if (typeof m !== 'object' || m === null || !('id' in m) || !('address' in m)) {
        return true;
      }
      const member = m as { id?: unknown; address?: unknown };
      return typeof member.id !== 'string' || typeof member.address !== 'string';
    })
  ) {
    throw new Error(`Invalid config: voters must be ClusterMember objects with id and address strings.`);
  }

  if (
    request.config.learners.some((m: unknown) => {
      if (typeof m !== 'object' || m === null || !('id' in m) || !('address' in m)) {
        return true;
      }
      const member = m as { id?: unknown; address?: unknown };
      return typeof member.id !== 'string' || typeof member.address !== 'string';
    })
  ) {
    throw new Error(`Invalid config: learners must be ClusterMember objects with id and address strings.`);
  }
}

/** Validates InstallSnapshot response payload. */
export function validateInstallSnapshotResponse(response: InstallSnapshotResponse): void {
  if (!Number.isInteger(response.term) || response.term < 0) {
    throw new Error(`Invalid term: ${response.term}. term must be a non-negative integer.`);
  }

  if (typeof response.success !== 'boolean') {
    throw new Error(`Invalid success: ${String(response.success)}. success must be a boolean.`);
  }
}

/**
 * Validates any RPC message envelope and its typed payload.
 *
 * @throws Error When message type, direction, or payload is invalid.
 */
export function validateRPCMessage(message: RPCMessage): void {
  switch (message.type) {
    case 'RequestVote':
      if (message.direction === 'request') {
        validateRequestVoteRequest(message.payload);
      } else {
        validateRequestVoteResponse(message.payload);
      }
      break;
    case 'AppendEntries':
      if (message.direction === 'request') {
        validateAppendEntriesRequest(message.payload);
      } else {
        validateAppendEntriesResponse(message.payload);
      }
      break;
    case 'InstallSnapshot':
      if (message.direction === 'request') {
        validateInstallSnapshotRequest(message.payload);
      } else {
        validateInstallSnapshotResponse(message.payload);
      }
      break;
    default:
      throw new Error('Unknown RPC message type.');
  }
}
