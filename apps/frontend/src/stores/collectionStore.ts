import { create } from 'zustand';
import { fetchCollections, createCollection, deleteCollection } from '../api/client';

interface CollectionState {
  collections: string[];
  loading: boolean;
  fetch: () => Promise<void>;
  create: (name: string) => Promise<void>;
  remove: (name: string) => Promise<void>;
}

export const useCollectionStore = create<CollectionState>((set) => ({
  collections: [],
  loading: false,

  async fetch() {
    set({ loading: true });
    try {
      const cols = await fetchCollections();
      set({ collections: cols });
    } finally {
      set({ loading: false });
    }
  },

  async create(name) {
    await createCollection(name);
    set((s) => ({ collections: [...s.collections, name] }));
  },

  async remove(name) {
    await deleteCollection(name);
    set((s) => ({ collections: s.collections.filter((c) => c !== name) }));
  },
}));
