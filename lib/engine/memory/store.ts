import type { TypedSupabaseClient } from "@/types";
import type { Json } from "@/types/database";

import { emptyMemory, parseMemoryRow, type MemoryRecentContext, type PersonMemory } from "./types";

export interface MemoryStore {
  /** Memories for the given people; missing rows come back as empty memories. */
  loadMany(personIds: string[]): Promise<Map<string, PersonMemory>>;
  saveRecentContext(personId: string, recentContext: MemoryRecentContext): Promise<void>;
}

// ---------------------------------------------------------------------------
// Supabase implementation
// ---------------------------------------------------------------------------

export function createSupabaseMemoryStore(client: TypedSupabaseClient): MemoryStore {
  return {
    async loadMany(personIds) {
      const result = new Map<string, PersonMemory>();
      if (personIds.length === 0) return result;
      const { data, error } = await client.from("person_memory").select("*").in("person_id", personIds);
      if (error) throw new Error(`Failed to load person memory: ${error.message}`);
      for (const row of data) result.set(row.person_id, parseMemoryRow(row));
      for (const id of personIds) if (!result.has(id)) result.set(id, emptyMemory(id));
      return result;
    },

    async saveRecentContext(personId, recentContext) {
      const { error } = await client
        .from("person_memory")
        .upsert(
          { person_id: personId, recent_context: recentContext as unknown as Json, updated_at: new Date().toISOString() },
          { onConflict: "person_id", defaultToNull: false },
        );
      if (error) throw new Error(`Failed to save person memory: ${error.message}`);
    },
  };
}

// ---------------------------------------------------------------------------
// TTL cache wrapper: a person's memory is fetched at most once per TTL, so
// batches within a tick (and consecutive ticks) do not re-read it.
// ---------------------------------------------------------------------------

export function withMemoryCache(store: MemoryStore, ttlMs: number, now: () => number = Date.now): MemoryStore {
  const cache = new Map<string, { memory: PersonMemory; expiresAt: number }>();
  return {
    async loadMany(personIds) {
      const result = new Map<string, PersonMemory>();
      const missing: string[] = [];
      const time = now();
      for (const id of personIds) {
        const hit = cache.get(id);
        if (hit && hit.expiresAt > time) result.set(id, hit.memory);
        else missing.push(id);
      }
      if (missing.length > 0) {
        const loaded = await store.loadMany(missing);
        for (const [id, memory] of loaded) {
          cache.set(id, { memory, expiresAt: time + ttlMs });
          result.set(id, memory);
        }
      }
      return result;
    },
    async saveRecentContext(personId, recentContext) {
      await store.saveRecentContext(personId, recentContext);
      const hit = cache.get(personId);
      if (hit) hit.memory = { ...hit.memory, recentContext };
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory implementation (tests)
// ---------------------------------------------------------------------------

export interface MemoryMemoryStore extends MemoryStore {
  readonly memories: Map<string, PersonMemory>;
  loadCalls: number;
}

export function createMemoryMemoryStore(seed: PersonMemory[] = []): MemoryMemoryStore {
  const memories = new Map(seed.map((m) => [m.personId, m]));
  const store: MemoryMemoryStore = {
    memories,
    loadCalls: 0,
    async loadMany(personIds) {
      store.loadCalls += 1;
      return new Map(personIds.map((id) => [id, memories.get(id) ?? emptyMemory(id)]));
    },
    async saveRecentContext(personId, recentContext) {
      const existing = memories.get(personId) ?? emptyMemory(personId);
      memories.set(personId, { ...existing, recentContext, updatedAt: new Date().toISOString() });
    },
  };
  return store;
}
