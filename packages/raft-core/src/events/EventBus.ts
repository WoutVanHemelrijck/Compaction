// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { RaftEvent, RaftEventBus } from './RaftEvents';

/**
 * In-process event bus implementation with in-memory subscriber list.
 */
export class LocalEventBus implements RaftEventBus {
  private handlers: Array<(event: RaftEvent) => void> = [];

  /** Publishes an event to all current subscribers. */
  emit(event: RaftEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // pass
      }
    }
  }

  /**
   * Registers a subscriber callback.
   *
   * @param handler Subscriber function.
   * @returns Unsubscribe callback.
   */
  subscribe(handler: (event: RaftEvent) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }
}

/**
 * Event bus implementation that drops all events and subscriptions.
 */
export class NoOpEventBus implements RaftEventBus {
  /** Ignores published events. */
  emit(_event: RaftEvent): void {
    // no-op
  }
  /** Returns a no-op unsubscribe callback. */
  subscribe(_handler: (event: RaftEvent) => void): () => void {
    return () => {
      // no-op
    };
  }
}
