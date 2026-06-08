// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { EventStore } from './EventStore';
import { RaftEventBus, RaftEvent } from './RaftEvents';
import { RaftState } from '../core/StateMachine';

type EventWithTerm = RaftEvent & { term?: number };

function makeBus(): RaftEventBus & { fire: (event: RaftEvent) => void } {
  const handlers: Array<(event: RaftEvent) => void> = [];
  return {
    emit: vi.fn(),
    subscribe: (handler) => {
      handlers.push(handler);
      return () => handlers.splice(handlers.indexOf(handler), 1);
    },
    fire(event: RaftEvent) {
      handlers.forEach((handler) => handler(event));
    },
  };
}

function makeEvent(override: Partial<RaftEvent> = {}): RaftEvent {
  return {
    eventId: crypto.randomUUID(),
    timestamp: performance.now(),
    wallTime: Date.now(),
    nodeId: 'node-1',
    type: 'ElectionStarted',
    ...override,
  } as RaftEvent;
}

describe('EventStore.ts, EventStore', () => {
  let bus: ReturnType<typeof makeBus>;

  beforeEach(() => {
    bus = makeBus();
  });

  it('should start with an empty event store', () => {
    const store = new EventStore(bus, { maxEvents: 10 });
    expect(store.getAllEvents()).toEqual([]);
    expect(store.getSize()).toBe(0);
  });

  it('stores events as they arrive', () => {
    const store = new EventStore(bus, { maxEvents: 10 });

    const event1 = makeEvent({ term: 1 });
    const event2 = makeEvent({ term: 2 });

    bus.fire(event1);
    bus.fire(event2);

    expect(store.getSize()).toBe(2);
    expect(store.getAllEvents()).toEqual([event1, event2]);
  });

  it('should preserve event order', () => {
    const store = new EventStore(bus, { maxEvents: 10 });
    const events = [1, 2, 3, 4, 5].map((term) => makeEvent({ term }));

    events.forEach((e) => bus.fire(e));

    const stored = store.getAllEvents();

    expect(stored.map((e) => (e as EventWithTerm).term)).toEqual([1, 2, 3, 4, 5]);
  });

  it('should drop oldest event when over maxEvents', () => {
    const store = new EventStore(bus, { maxEvents: 3 });
    const events = [1, 2, 3, 4].map((term) => makeEvent({ term }));

    events.forEach((e) => bus.fire(e));

    expect(store.getSize()).toBe(3);

    const stored = store.getAllEvents();

    expect((stored[0] as EventWithTerm).term).toBe(2);
    expect((stored[2] as EventWithTerm).term).toBe(4);
  });

  it('never exceeds maxEvents', () => {
    const store = new EventStore(bus, { maxEvents: 5 });

    for (let i = 0; i < 100; i++) {
      bus.fire(makeEvent({ term: i }));
    }

    expect(store.getSize()).toBe(5);
  });

  it('keeps the most recent events in order', () => {
    const store = new EventStore(bus, { maxEvents: 3 });

    for (let i = 1; i <= 10; i++) {
      bus.fire(makeEvent({ term: i }));
    }

    const terms = store.getAllEvents().map((e) => (e as EventWithTerm).term);
    expect(terms).toEqual([8, 9, 10]);
  });

  it('should return a copy, not the internal array', () => {
    const store = new EventStore(bus, { maxEvents: 10 });
    bus.fire(makeEvent());

    const result = store.getAllEvents();

    result.push(makeEvent());

    expect(store.getSize()).toBe(1);
  });

  it('calls subscriber for each new event', () => {
    const store = new EventStore(bus, { maxEvents: 10 });
    const received: RaftEvent[] = [];

    store.onLiveEvent((e) => received.push(e));

    const event1 = makeEvent({ term: 1 });
    const event2 = makeEvent({ term: 2 });

    bus.fire(event1);
    bus.fire(event2);

    expect(received).toEqual([event1, event2]);
  });

  it('does not call subscriber for events that arrived before subscription', () => {
    const store = new EventStore(bus, { maxEvents: 10 });

    bus.fire(makeEvent({ term: 1 }));

    const received: RaftEvent[] = [];

    store.onLiveEvent((e) => received.push(e));

    expect(received).toHaveLength(0);
  });

  it('supports multiple simultaneous subscribers', () => {
    const store = new EventStore(bus, { maxEvents: 10 });

    const a: RaftEvent[] = [];
    const b: RaftEvent[] = [];

    store.onLiveEvent((e) => a.push(e));
    store.onLiveEvent((e) => b.push(e));

    bus.fire(makeEvent());

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('should stop future events when unsubsscribe', () => {
    const store = new EventStore(bus, { maxEvents: 10 });
    const received: RaftEvent[] = [];
    const unsubscribe = store.onLiveEvent((e) => received.push(e));

    bus.fire(makeEvent({ term: 1 }));

    unsubscribe();

    bus.fire(makeEvent({ term: 2 }));

    expect(received).toHaveLength(1);
    expect((received[0] as EventWithTerm).term).toBe(1);
  });

  it('should not affect others when unsubscribing', () => {
    const store = new EventStore(bus, { maxEvents: 10 });

    const a: RaftEvent[] = [];
    const b: RaftEvent[] = [];

    const unsubA = store.onLiveEvent((e) => a.push(e));

    store.onLiveEvent((e) => b.push(e));

    bus.fire(makeEvent({ term: 1 }));

    unsubA();

    bus.fire(makeEvent({ term: 2 }));

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);
  });

  it('should not throw when unsubscribing twice', () => {
    const store = new EventStore(bus, { maxEvents: 10 });
    const unsubscribe = store.onLiveEvent(() => {});

    expect(() => {
      unsubscribe();
      unsubscribe();
    }).not.toThrow();
  });

  it('should store different types of events', () => {
    const store = new EventStore(bus, { maxEvents: 10 });

    bus.fire(makeEvent({ type: 'ElectionStarted', term: 1 }));

    bus.fire({
      eventId: crypto.randomUUID(),
      timestamp: performance.now(),
      wallTime: Date.now(),
      nodeId: 'node-1',
      type: 'NodeStateChanged',
      oldState: RaftState.Follower,
      newState: RaftState.Candidate,
      term: 1,
    });

    expect(store.getSize()).toBe(2);
    expect(store.getAllEvents()[0].type).toBe('ElectionStarted');
    expect(store.getAllEvents()[1].type).toBe('NodeStateChanged');
  });
});
