/**
 * Flag storage for Flagpole.
 *
 * The source of truth is an in-memory Map, which keeps reads O(1) and the
 * whole service dependency-free. When a data file path is provided, every
 * mutation is flushed to disk as pretty-printed JSON and the file is loaded
 * back on startup — enough durability for small self-hosted deployments
 * without pulling in a database.
 *
 * Writes are synchronous by design: flag mutations are rare and tiny, and
 * a sync flush guarantees the file is consistent before the API responds.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CreateFlagInput, Flag, UpdateFlagInput } from "./types.js";

export interface FlagStore {
  list(): Flag[];
  get(key: string): Flag | undefined;
  has(key: string): boolean;
  create(input: CreateFlagInput): Flag;
  update(key: string, input: UpdateFlagInput): Flag | undefined;
  delete(key: string): boolean;
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

  if (dataFile && existsSync(dataFile)) {
    // A corrupt data file should fail loudly at startup rather than
    // silently starting with an empty flag set, which could flip every
    // flag off for downstream consumers.
    const raw = readFileSync(dataFile, "utf8");
    const parsed: Flag[] = JSON.parse(raw);
    for (const flag of parsed) {
      flags.set(flag.key, flag);
    }
  }

  const persist = (): void => {
    if (!dataFile) return;
    mkdirSync(dirname(dataFile), { recursive: true });
    // Write-then-rename so a crash mid-write never truncates the real file.
    const tmpPath = `${dataFile}.tmp`;
    writeFileSync(tmpPath, JSON.stringify([...flags.values()], null, 2));
    renameSync(tmpPath, dataFile);
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
      flags.set(flag.key, flag);
      persist();
      return flag;
    },

    update(key, input) {
      const existing = flags.get(key);
      if (!existing) return undefined;
      const updated: Flag = {
        ...existing,
        description: input.description ?? existing.description,
        enabled: input.enabled ?? existing.enabled,
        updatedAt: new Date().toISOString(),
      };
      flags.set(key, updated);
      persist();
      return updated;
    },

    delete(key) {
      const removed = flags.delete(key);
      if (removed) persist();
      return removed;
    },
  };
}
