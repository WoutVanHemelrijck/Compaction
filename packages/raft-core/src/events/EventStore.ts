// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { RaftEvent, RaftEventBus } from './RaftEvents';

/**
 * Configuration for in-memory event retention.
 */
export interface EventStoreOptions {
  /** Maximum number of retained historical events. */
  maxEvents: number;
}

/**
 * In-memory event store that records bus events and broadcasts live updates.
 */
export class EventStore {
  private events: RaftEvent[] = [];
  private liveSubscribers: Set<(event: RaftEvent) => void> = new Set();

  /**
   * Subscribes to an event bus and starts buffering incoming events.
   *
   * @param bus Source event bus.
   * @param options Retention configuration.
   */
  constructor(
    bus: RaftEventBus,
    private options: EventStoreOptions,
  ) {
    bus.subscribe((event) => this.append(event));
  }

  /** Appends an event to retention buffer and notifies live subscribers. */
  private append(event: RaftEvent): void {
    this.events.push(event);

    if (this.events.length > this.options.maxEvents) {
      this.events.shift();
    }

    for (const subscriber of this.liveSubscribers) {
      subscriber(event);
    }
  }

  /** Returns a copy of currently retained events. */
  getAllEvents(): RaftEvent[] {
    return [...this.events];
  }

  /**
   * Subscribes to live appended events.
   *
   * @param subscriber Live event callback.
   * @returns Unsubscribe callback.
   */
  onLiveEvent(subscriber: (event: RaftEvent) => void): () => void {
    this.liveSubscribers.add(subscriber);
    return () => this.liveSubscribers.delete(subscriber);
  }

  /** Returns current number of retained events. */
  getSize(): number {
    return this.events.length;
  }
}
