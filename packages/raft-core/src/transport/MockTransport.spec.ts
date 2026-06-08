// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { describe, it, expect, beforeEach } from 'vitest';
import { MockTransport } from './MockTransport';
import { NetworkError } from '../util/Error';
import { SeededRandom } from '../util/Random';
import { RPCMessage } from '../rpc/RPCTypes';

describe('MockTransport.ts, MockTransport', () => {
  let transportA: MockTransport;
  let transportB: MockTransport;
  let random: SeededRandom;

  const validMessage: RPCMessage = {
    type: 'RequestVote',
    direction: 'request',
    payload: {
      term: 1,
      candidateId: 'node1',
      lastLogIndex: 0,
      lastLogTerm: 0,
    },
  };

  beforeEach(() => {
    MockTransport.reset();
    random = new SeededRandom(123);
    transportA = new MockTransport('A', random);
    transportB = new MockTransport('B', random);
  });

  it('should start and stop transport', async () => {
    await transportA.start();
    expect(transportA.isStarted()).toBe(true);
    await expect(transportA.start()).rejects.toThrow(NetworkError);
    await transportA.stop();
    expect(transportA.isStarted()).toBe(false);
    await expect(transportA.stop()).rejects.toThrow(NetworkError);
  });

  it('should throw if sending message when transport is not started', async () => {
    await expect(transportA.send('B', validMessage)).rejects.toThrow(NetworkError);
  });

  it('should throw when message is dropped due to drop rate', async () => {
    transportA.setDropRate(1);
    await transportA.start();
    await expect(transportA.send('B', validMessage)).rejects.toThrow(NetworkError);
  });

  it('should throw when message is dropped due to partition', async () => {
    MockTransport.partition(['A'], ['B']);
    await transportA.start();
    await expect(transportA.send('B', validMessage)).rejects.toThrow(NetworkError);
  });

  it('should throw when peer has no transport', async () => {
    await transportA.start();
    await expect(transportA.send('C', validMessage)).rejects.toThrow(NetworkError);
  });

  it('should throw if peer is not started', async () => {
    await transportA.start();
    await expect(transportA.send('B', validMessage)).rejects.toThrow(NetworkError);
  });

  it('should throw if peer has no handler', async () => {
    await transportA.start();
    await transportB.start();
    await expect(transportA.send('B', validMessage)).rejects.toThrow(NetworkError);
  });

  it('should send message successfully', async () => {
    await transportA.start();
    await transportB.start();
    let handlerCalled = false;
    transportB.onMessage(async (from, message) => {
      expect(from).toBe('A');
      expect(message).toEqual(validMessage);
      handlerCalled = true;

      await new Promise((resolve) => setTimeout(resolve, 10));

      return {
        type: 'RequestVote',
        direction: 'response',
        payload: {
          term: 1,
          voteGranted: true,
        },
      };
    });
    await transportA.send('B', validMessage);
    expect(handlerCalled).toBe(true);
  });

  it('should catch error thrown by handler and rethrow as NetworkError', async () => {
    await transportA.start();
    await transportB.start();
    transportB.onMessage(() => {
      throw new Error('Handler error');
    });
    await expect(transportA.send('B', validMessage)).rejects.toThrow(NetworkError);
  });

  it('should throw error for invalid drop rate', () => {
    expect(() => transportA.setDropRate(-0.1)).toThrow(NetworkError);
    expect(() => transportA.setDropRate(1.1)).toThrow(NetworkError);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
    expect(() => transportA.setDropRate('not an integer' as any)).toThrow(NetworkError);
  });

  it('should set and get drop rate correctly', () => {
    transportA.setDropRate(0.5);
    expect(transportA.getDropRate()).toBe(0.5);
  });

  it('should partition and heal network correctly', async () => {
    MockTransport.partition(['A'], ['B']);
    await transportA.start();
    await transportB.start();
    await expect(transportA.send('B', validMessage)).rejects.toThrow(NetworkError);
    MockTransport.healPartition();
    let handlerCalled = false;
    transportB.onMessage(async (from, message) => {
      expect(from).toBe('A');
      expect(message).toEqual(validMessage);
      handlerCalled = true;

      await new Promise((resolve) => setTimeout(resolve, 10));

      return {
        type: 'RequestVote',
        direction: 'response',
        payload: {
          term: 1,
          voteGranted: true,
        },
      };
    });
    await transportA.send('B', validMessage);
    expect(handlerCalled).toBe(true);
  });

  it('should check isPartitioned correctly', () => {
    MockTransport.partition(['A', 'D'], ['B']);
    expect(MockTransport.isPartitioned('A', 'B')).toBe(true);
    expect(MockTransport.isPartitioned('A', 'C')).toBe(true);
    expect(MockTransport.isPartitioned('B', 'C')).toBe(true);
    expect(MockTransport.isPartitioned('A', 'D')).toBe(false);
    expect(MockTransport.isPartitioned('B', 'D')).toBe(true);
    expect(MockTransport.isPartitioned('C', 'D')).toBe(true);
  });

  it('should reset transports and partitions correctly', async () => {
    await transportA.start();
    await transportB.start();
    MockTransport.partition(['A'], ['B']);
    MockTransport.reset();
    expect(MockTransport.getRegisteredNodes()).toEqual([]);
    expect(MockTransport.isPartitioned('A', 'B')).toBe(false);
  });

  it('should get registered nodes correctly', async () => {
    await transportA.start();
    await transportB.start();
    const nodes = MockTransport.getRegisteredNodes();
    expect(nodes).toContain('A');
    expect(nodes).toContain('B');
  });

  it('should be able to cut a link and restore it', async () => {
    await transportA.start();
    await transportB.start();
    MockTransport.cutLink('A', 'B');
    await expect(transportA.send('B', validMessage)).rejects.toThrow(NetworkError);
    MockTransport.healLink('A', 'B');
    let handlerCalled = false;
    transportB.onMessage(async (from, message) => {
      expect(from).toBe('A');
      expect(message).toEqual(validMessage);
      handlerCalled = true;

      await new Promise((resolve) => setTimeout(resolve, 10));

      return {
        type: 'RequestVote',
        direction: 'response',
        payload: {
          term: 1,
          voteGranted: true,
        },
      };
    });
    await transportA.send('B', validMessage);
    expect(handlerCalled).toBe(true);
  });

  it('should be able to cut multiple links and restore them', async () => {
    const transportC = new MockTransport('C', random);
    await transportA.start();
    await transportB.start();
    await transportC.start();

    MockTransport.cutLink('A', 'B');
    MockTransport.cutLink('B', 'C');
    MockTransport.cutLink('A', 'C');

    await expect(transportA.send('B', validMessage)).rejects.toThrow(NetworkError);
    await expect(transportB.send('C', validMessage)).rejects.toThrow(NetworkError);
    await expect(transportA.send('C', validMessage)).rejects.toThrow(NetworkError);

    MockTransport.healAllLinks();

    let handlerCalled = false;
    transportB.onMessage(async (from, message) => {
      expect(from).toBe('A');
      expect(message).toEqual(validMessage);
      handlerCalled = true;

      await new Promise((resolve) => setTimeout(resolve, 10));

      return {
        type: 'RequestVote',
        direction: 'response',
        payload: {
          term: 1,
          voteGranted: true,
        },
      };
    });
    await transportA.send('B', validMessage);
    expect(handlerCalled).toBe(true);
    handlerCalled = false;
    transportC.onMessage(async (from, message) => {
      expect(from).toBe('B');
      expect(message).toEqual(validMessage);
      handlerCalled = true;

      await new Promise((resolve) => setTimeout(resolve, 10));

      return {
        type: 'RequestVote',
        direction: 'response',
        payload: {
          term: 1,
          voteGranted: true,
        },
      };
    });
    await transportB.send('C', validMessage);
    expect(handlerCalled).toBe(true);
    handlerCalled = false;
    transportC.onMessage(async (from, message) => {
      expect(from).toBe('A');
      expect(message).toEqual(validMessage);
      handlerCalled = true;

      await new Promise((resolve) => setTimeout(resolve, 10));

      return {
        type: 'RequestVote',
        direction: 'response',
        payload: {
          term: 1,
          voteGranted: true,
        },
      };
    });
    await transportA.send('C', validMessage);
    expect(handlerCalled).toBe(true);
  });

  it('should set the drop rate with the static setdroprate method', async () => {
    await transportA.start();
    await transportB.start();

    MockTransport.setDropRate('A', 0.5);
    expect(transportA.getDropRate()).toBe(0.5);
    expect(transportB.getDropRate()).toBe(0);
  });

  it('should return early when setting droprate for a node that does not exist', () => {
    expect(() => MockTransport.setDropRate('C', 0.5)).not.toThrow();
  });
});
