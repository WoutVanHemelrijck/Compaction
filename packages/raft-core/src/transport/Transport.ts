// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { NodeId } from '../core/Config';
import { RPCMessage } from '../rpc/RPCTypes';

/**
 * Inbound transport message handler signature.
 */
export type MessageHandler = (from: NodeId, message: RPCMessage) => Promise<RPCMessage>;

/**
 * Transport abstraction for Raft RPC exchange.
 */
export interface Transport {
  /** Starts the transport listener/client resources. */
  start(): Promise<void>;
  /** Stops the transport and releases resources. */
  stop(): Promise<void>;
  /** Returns true when transport is currently started. */
  isStarted(): boolean;
  /** Sends one RPC message to a peer and returns response message. */
  send(peerId: NodeId, message: RPCMessage): Promise<RPCMessage>;
  /** Registers inbound request handler. */
  onMessage(handler: MessageHandler): void;
  /** Optionally registers a peer endpoint at runtime. */
  addPeer?(peerId: NodeId, address: string): Promise<void>;
  /** Optionally removes a peer endpoint at runtime. */
  removePeer?(peerId: NodeId): void;
}
