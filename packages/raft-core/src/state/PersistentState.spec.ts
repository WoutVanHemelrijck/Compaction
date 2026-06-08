// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { describe, it, expect } from 'vitest';
import { PersistentState } from './PersistentState';
import { InMemoryMetaStorage } from '../storage/inMemory/InMemoryMetaStorage';
import { PersistentStateError, StorageError } from '../util/Error';
import { MetaData } from '../storage/interfaces/MetaStorage';
import { NodeId } from '../core/Config';

describe('PersistentState.ts, PersistentState', () => {
  class FailingWriteStorage extends InMemoryMetaStorage {
    write(_term: number, _votedFor: NodeId | null): Promise<void> {
      return Promise.reject(new StorageError('Storage write error'));
    }
  }

  class FailingWriteStorage2 extends InMemoryMetaStorage {
    write(_term: number, _votedFor: NodeId | null): Promise<void> {
      return Promise.reject(new Error('Generic error'));
    }
  }

  class FailingReadStorage extends InMemoryMetaStorage {
    read(): Promise<MetaData | null> {
      return Promise.reject(new StorageError('Storage read error'));
    }
  }

  it('should initialize with empty storage', async () => {
    const meta = new InMemoryMetaStorage();
    await meta.open();
    const persistentState = new PersistentState(meta);
    const snapshot = await persistentState.initialize();
    expect(snapshot.currentTerm).toBe(0);
    expect(snapshot.votedFor).toBeNull();
  });

  it('should return early when already initialized', async () => {
    const meta = new InMemoryMetaStorage();
    await meta.open();
    const persistentState = new PersistentState(meta);
    await persistentState.initialize();
    const snapshot = await persistentState.initialize();
    expect(snapshot.currentTerm).toBe(0);
    expect(snapshot.votedFor).toBeNull();
  });

  it('should throw when storage is not open', async () => {
    const meta = new InMemoryMetaStorage();
    const persistentState = new PersistentState(meta);
    await expect(persistentState.initialize()).rejects.toThrow(PersistentStateError);
  });

  it('should throw when calling a method before initialization', () => {
    const meta = new InMemoryMetaStorage();
    const persistentState = new PersistentState(meta);
    expect(() => persistentState.getCurrentTerm()).toThrow(PersistentStateError);
  });

  it('should throw PersistentStateError if restore fails with StorageError', async () => {
    const meta = new FailingReadStorage();
    await meta.open();
    const persistentState = new PersistentState(meta);
    await expect(persistentState.initialize()).rejects.toThrow(PersistentStateError);
  });

  it('should restore existing term from storage', async () => {
    const meta = new InMemoryMetaStorage();
    await meta.open();
    await meta.write(5, null);

    const persistentState = new PersistentState(meta);
    const snapshot = await persistentState.initialize();
    expect(snapshot.currentTerm).toBe(5);
    expect(persistentState.getCurrentTerm()).toBe(5);
    expect(persistentState.getVotedFor()).toBeNull();
  });

  it('should restore existing term and votedFor from storage', async () => {
    const meta = new InMemoryMetaStorage();
    await meta.open();
    await meta.write(3, 'node2');

    const persistentState = new PersistentState(meta);
    const snapshot = await persistentState.initialize();
    expect(snapshot.currentTerm).toBe(3);
    expect(snapshot.votedFor).toBe('node2');
  });

  it('should get and set current term', async () => {
    const meta = new InMemoryMetaStorage();
    await meta.open();
    const persistentState = new PersistentState(meta);
    await persistentState.initialize();
    expect(persistentState.getCurrentTerm()).toBe(0);
    await persistentState.setCurrentTerm(5);
    expect(persistentState.getCurrentTerm()).toBe(5);
  });

  it('should get and set votedFor', async () => {
    const meta = new InMemoryMetaStorage();
    await meta.open();
    const persistentState = new PersistentState(meta);
    await persistentState.initialize();
    expect(persistentState.getVotedFor()).toBeNull();
    await persistentState.updateTermAndVote(1, 'node1');
    expect(persistentState.getVotedFor()).toBe('node1');
  });

  it('updateTermandVote should throw for non-integer term', async () => {
    const meta = new InMemoryMetaStorage();
    await meta.open();
    const persistentState = new PersistentState(meta);
    await persistentState.initialize();
    await expect(persistentState.updateTermAndVote('not an integer' as unknown as number, 'node1')).rejects.toThrow(
      PersistentStateError,
    );
  });

  it('updateTermandVote should throw for negative term', async () => {
    const meta = new InMemoryMetaStorage();
    await meta.open();
    const persistentState = new PersistentState(meta);
    await persistentState.initialize();
    await expect(persistentState.updateTermAndVote(-1, 'node1')).rejects.toThrow(PersistentStateError);
  });

  it('updateTermandVote should throw for new term less than current term', async () => {
    const meta = new InMemoryMetaStorage();
    await meta.open();
    const persistentState = new PersistentState(meta);
    await persistentState.initialize();
    await persistentState.setCurrentTerm(5);
    await expect(persistentState.updateTermAndVote(4, 'node1')).rejects.toThrow(PersistentStateError);
  });

  it('updateTermandVote should work for votedFor not null', async () => {
    const meta = new InMemoryMetaStorage();
    await meta.open();
    const persistentState = new PersistentState(meta);
    await persistentState.initialize();
    await persistentState.updateTermAndVote(1, 'node1');
    expect(persistentState.getCurrentTerm()).toBe(1);
    expect(persistentState.getVotedFor()).toBe('node1');
  });

  it('updateTermandVote should work for votedFor null', async () => {
    const meta = new InMemoryMetaStorage();
    await meta.open();
    const persistentState = new PersistentState(meta);
    await persistentState.initialize();
    await persistentState.updateTermAndVote(1, 'node1');
    await persistentState.updateTermAndVote(2, null);
    expect(persistentState.getCurrentTerm()).toBe(2);
    expect(persistentState.getVotedFor()).toBeNull();
  });

  it('updateTermandVote should return early if term and votedFor are unchanged', async () => {
    const meta = new InMemoryMetaStorage();
    await meta.open();
    const persistentState = new PersistentState(meta);
    await persistentState.initialize();
    await persistentState.updateTermAndVote(1, 'node1');
    expect(persistentState.getCurrentTerm()).toBe(1);
    expect(persistentState.getVotedFor()).toBe('node1');
    await persistentState.updateTermAndVote(1, 'node1');
    expect(persistentState.getCurrentTerm()).toBe(1);
    expect(persistentState.getVotedFor()).toBe('node1');
  });

  it('updateTermandVote should throw PersistentStateError on StorageError', async () => {
    const meta = new FailingWriteStorage();
    await meta.open();
    const persistentState = new PersistentState(meta);
    await persistentState.initialize();
    await expect(persistentState.updateTermAndVote(1, 'node1')).rejects.toThrow(PersistentStateError);
  });

  it('updateTermandVote should throw PersistentStateError on generic error', async () => {
    const meta = new FailingWriteStorage2();
    await meta.open();
    const persistentState = new PersistentState(meta);
    await persistentState.initialize();
    await expect(persistentState.updateTermAndVote(1, 'node1')).rejects.toThrow(PersistentStateError);
  });

  it('clear should reset the state', async () => {
    const meta = new InMemoryMetaStorage();
    await meta.open();
    const persistentState = new PersistentState(meta);
    await persistentState.initialize();
    await persistentState.updateTermAndVote(1, 'node1');
    await persistentState.clear();
    expect(persistentState.getCurrentTerm()).toBe(0);
    expect(persistentState.getVotedFor()).toBeNull();
  });

  it('clear should throw PersistentStateError on StorageError', async () => {
    const meta = new FailingWriteStorage();
    await meta.open();
    const persistentState = new PersistentState(meta);
    await persistentState.initialize();
    await expect(persistentState.clear()).rejects.toThrow(PersistentStateError);
  });

  it('clear should throw PersistentStateError on generic error', async () => {
    const meta = new FailingWriteStorage2();
    await meta.open();
    const persistentState = new PersistentState(meta);
    await persistentState.initialize();
    await expect(persistentState.clear()).rejects.toThrow(PersistentStateError);
  });
});
