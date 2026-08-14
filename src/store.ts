/**
 * Flag storage for Flagpole.
 *
 * The source of truth is an in-memory Map, which keeps reads O(1) and the
 * whole service dependency-free. When a data file path is provided, every
 * mutation is flushed to disk as pretty-printed JSON and the file is loaded
 * back on startup — enough durability for small self-hosted deployments
 * without pulling in a database.
 *
 * Alongside the flags themselves the store keeps a per-key change history:
 * every create/update/delete appends a FlagEvent. History is keyed by flag
 * key and deliberately survives deletion, so "who turned this off and when"
 * remains answerable after a flag is removed.
 *
 * Writes are synchronous by design: flag mutations are rare and tiny, and
 * a sync flush guarantees the file is consistent before the API responds.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CreateFlagInput, Flag, FlagEvent, UpdateFlagInput } from "./types.js";

export interface FlagStore {
  list(): Flag[];
  get(key: string): Flag | undefined;
  has(key: string): boolean;
  create(input: CreateFlagInput): Flag;
  update(key: string, input: UpdateFlagInput): Flag | undefined;
  delete(key: string): boolean;
  /**
   * Change history for a key, oldest first. Returns `undefined` only when
   * the key has never existed; a deleted flag still has its history, and a
   * flag loaded from a pre-history data file yields an empty array.
   */
  history(key: string): FlagEvent[] | undefined;
}

/**
 * On-disk shape. Older data files were a bare `Flag[]`; both forms are
 * accepted on load so upgrading Flagpole never requires migrating the file.
 */
interface DataFileContents {
  flags: Flag[];
  events: Record<string, FlagEvent[]>;
}

/**
 * Create a flag store.
 *
 * @param dataFile Optional path to a JSON file used for persistence. If the
 *   file exists it is loaded on startup; if not, it is created on the first
 *   write (including any missing parent directories).
 */
export function createStore(dataFile?: string): FlagStore {
  const flags = new Map<string, Flag>();
  const events = new Map<string, FlagEvent[]>();

  if (dataFile && existsSync(dataFile)) {
    // A corrupt data file should fail loudly at startup rather than
    // silently starting with an empty flag set, which could flip every
    // flag off for downstream consumers.
    const raw = readFileSync(dataFile, "utf8");
    const parsed: Flag[] | DataFileContents = JSON.parse(raw);
    const loadedFlags = Array.isArray(parsed) ? parsed : parsed.flags;
    for (const flag of loadedFlags) {
      flags.set(flag.key, flag);
    }
    if (!Array.isArray(parsed)) {
      for (const [key, history] of Object.entries(parsed.events ?? {})) {
        events.set(key, history);
      }
    }
  }

  const persist = (): void => {
    if (!dataFile) return;
    mkdirSync(dirname(dataFile), { recursive: true });
    const contents: DataFileContents = {
      flags: [...flags.values()],
      events: Object.fromEntries(events),
    };
    // Write-then-rename so a crash mid-write never truncates the real file.
    const tmpPath = `${dataFile}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(contents, null, 2));
    renameSync(tmpPath, dataFile);
  };

  const recordEvent = (
    key: string,
    type: FlagEvent["type"],
    at: string,
    changes: Record<string, unknown>,
  ): void => {
    const history = events.get(key) ?? [];
    history.push({ type, at, changes });
    events.set(key, history);
  };

  return {
    list() {
      return [...flags.values()];
    },

    get(key) {
      return flags.get(key);
    },

    has(key) {
      return flags.has(key);
    },

    create(input) {
      const now = new Date().toISOString();
      const flag: Flag = {
        key: input.key,
        description: input.description ?? "",
        enabled: input.enabled,
        createdAt: now,
        updatedAt: now,
      };
      if (input.rolloutPercentage !== undefined) {
        flag.rolloutPercentage = input.rolloutPercentage;
      }
      flags.set(flag.key, flag);
      // The "created" event snapshots the initial user-settable values so
      // history alone can reconstruct the flag's starting state.
      const changes: Record<string, unknown> = {
        description: flag.description,
        enabled: flag.enabled,
      };
      if (flag.rolloutPercentage !== undefined) changes.rolloutPercentage = flag.rolloutPercentage;
      recordEvent(flag.key, "created", now, changes);
      persist();
      return flag;
    },

    update(key, input) {
      const existing = flags.get(key);
      if (!existing) return undefined;
      const now = new Date().toISOString();
      const updated: Flag = {
        ...existing,
        description: input.description ?? existing.description,
        enabled: input.enabled ?? existing.enabled,
        updatedAt: now,
      };
      if (input.rolloutPercentage !== undefined) {
        updated.rolloutPercentage = input.rolloutPercentage;
      }
      flags.set(key, updated);
      // Record only the fields the caller actually patched, so history
      // reads as a diff stream rather than repeated full snapshots.
      const changes: Record<string, unknown> = {};
      if (input.description !== undefined) changes.description = input.description;
      if (input.enabled !== undefined) changes.enabled = input.enabled;
      if (input.rolloutPercentage !== undefined) changes.rolloutPercentage = input.rolloutPercentage;
      recordEvent(key, "updated", now, changes);
      persist();
      return updated;
    },

    delete(key) {
      const removed = flags.delete(key);
      if (removed) {
        recordEvent(key, "deleted", new Date().toISOString(), {});
        persist();
      }
      return removed;
    },

    history(key) {
      const history = events.get(key);
      if (history) return history;
      // Flags loaded from a pre-history data file have no events yet;
      // still distinguish them from keys that never existed.
      return flags.has(key) ? [] : undefined;
    },
  };
}
