// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { describe, it, expect } from 'vitest';
import { LocalEventBus, NoOpEventBus } from './EventBus';
import { RaftEvent } from './RaftEvents';

describe('EventBus.ts, LocalEventBus', () => {
  const testEvent: RaftEvent = {
    eventId: 'test-event',
    timestamp: Date.now(),
    wallTime: Date.now(),
    nodeId: 'node-1',
    type: 'ElectionStarted',
    term: 1,
  };

  it('should deliver an event to a subscribed handler', () => {
    const bus = new LocalEventBus();
    let receivedEvent: RaftEvent | null = null;
    bus.subscribe((event) => {
      receivedEvent = event;
    });
    bus.emit(testEvent);
    expect(receivedEvent).toEqual(testEvent);
  });

  it('shoul deliver an event to multiple subscribed handlers', () => {
    const bus = new LocalEventBus();
    let receivedEvent1: RaftEvent | null = null;
    let receivedEvent2: RaftEvent | null = null;
    bus.subscribe((event) => {
      receivedEvent1 = event;
    });
    bus.subscribe((event) => {
      receivedEvent2 = event;
    });
    bus.emit(testEvent);
    expect(receivedEvent1).toEqual(testEvent);
    expect(receivedEvent2).toEqual(testEvent);
  });

  it('should not deliver events to unsubscribed handlers', () => {
    const bus = new LocalEventBus();
    let receivedEvent: RaftEvent | null = null;
    const unsubscribe = bus.subscribe((event) => {
      receivedEvent = event;
    });
    unsubscribe();
    bus.emit(testEvent);
    expect(receivedEvent).toBeNull();
  });

  it('should still deliver events to other handlers if one unsubscribes', () => {
    const bus = new LocalEventBus();
    let receivedEvent1: RaftEvent | null = null;
    let receivedEvent2: RaftEvent | null = null;
    const unsubscribe1 = bus.subscribe((event) => {
      receivedEvent1 = event;
    });
    bus.subscribe((event) => {
      receivedEvent2 = event;
    });
    unsubscribe1();
    bus.emit(testEvent);
    expect(receivedEvent1).toBeNull();
    expect(receivedEvent2).toEqual(testEvent);
  });

  it('should not throw if a handler throws an error', () => {
    const bus = new LocalEventBus();
    bus.subscribe(() => {
      throw new Error('Handler error');
    });
    expect(() => bus.emit(testEvent)).not.toThrow();
  });

  it('should still deliver events to other handlers if one throws an error', () => {
    const bus = new LocalEventBus();
    let receivedEvent: RaftEvent | null = null;
    bus.subscribe(() => {
      throw new Error('Handler error');
    });
    bus.subscribe((event) => {
      receivedEvent = event;
    });
    bus.emit(testEvent);
    expect(receivedEvent).toEqual(testEvent);
  });

  it('should not deliver with no handlers', () => {
    const bus = new LocalEventBus();
    expect(() => bus.emit(testEvent)).not.toThrow();
  });

  it('should not deliver events after all handlers are unsubscribed', () => {
    const bus = new LocalEventBus();
    let receivedEvent: RaftEvent | null = null;
    const unsubscribe1 = bus.subscribe((event) => {
      receivedEvent = event;
    });
    const unsubscribe2 = bus.subscribe((event) => {
      receivedEvent = event;
    });
    unsubscribe1();
    unsubscribe2();
    bus.emit(testEvent);
    expect(receivedEvent).toBeNull();
  });

  it('should not throw when unsubscribing a handler that was never subscribed', () => {
    const bus = new LocalEventBus();
    expect(() => bus.subscribe(() => {}).bind(null)()).not.toThrow();
  });
});

describe('EventBus.ts, NoOpEventBus', () => {
  const testEvent: RaftEvent = {
    eventId: 'test-event',
    timestamp: Date.now(),
    wallTime: Date.now(),
    nodeId: 'node-1',
    type: 'ElectionStarted',
    term: 1,
  };

  it('should not deliver events to any handlers', () => {
    const bus = new NoOpEventBus();
    let receivedEvent: RaftEvent | null = null;
    bus.subscribe((event) => {
      receivedEvent = event;
    });
    bus.emit(testEvent);
    expect(receivedEvent).toBeNull();
  });

  it('should not throw when emitting', () => {
    const bus = new NoOpEventBus();
    expect(() => bus.emit(testEvent)).not.toThrow();
  });

  it('should not throw when subscribing', () => {
    const bus = new NoOpEventBus();
    expect(() => bus.subscribe(() => {})).not.toThrow();
  });

  it('should return a no-op unsubscribe function', () => {
    const bus = new NoOpEventBus();
    const unsubscribe = bus.subscribe(() => {});
    expect(() => unsubscribe()).not.toThrow();
  });
});
