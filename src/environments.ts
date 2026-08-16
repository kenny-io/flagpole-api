/**
 * Per-environment flag overrides.
 *
 * A flag's `enabled` and `rolloutPercentage` are its defaults. An environment
 * override replaces either value for one environment only, so `production`
 * can lag `staging` without duplicating the flag. Reads fall back to the
 * flag's own values, which keeps every existing caller working unchanged.
 */

export interface Environment {
  key: string;
  displayName: string;
  createdAt: string;
}

export interface EnvironmentOverride {
  environment: string;
  enabled?: boolean;
  rolloutPercentage?: number;
}

export const ENVIRONMENT_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_ENVIRONMENT_KEY_LENGTH = 50;
export const DEFAULT_ENVIRONMENTS = ["development", "staging", "production"];

export interface EnvironmentRegistry {
  /** Every known environment, in creation order. */
  list(): Environment[];
  /** Register an environment. Returns `undefined` when the key is taken. */
  create(key: string, displayName?: string): Environment | undefined;
  /** Whether an environment is registered. */
  has(key: string): boolean;
  /** The override for one flag in one environment, if any. */
  override(flagKey: string, environment: string): EnvironmentOverride | undefined;
  /** Every override recorded for a flag, in environment order. */
  overrides(flagKey: string): EnvironmentOverride[];
  /** Create or replace an override. */
  setOverride(
    flagKey: string,
    environment: string,
    value: Omit<EnvironmentOverride, "environment">,
  ): EnvironmentOverride;
  /** Remove an override. `true` when one existed. */
  clearOverride(flagKey: string, environment: string): boolean;
  /** Drop every override for a flag; used when the flag is deleted. */
  clearFlag(flagKey: string): void;
}

/** Create a registry seeded with the conventional three environments. */
export function createEnvironmentRegistry(): EnvironmentRegistry {
  const environments = new Map<string, Environment>();
  const overrides = new Map<string, Map<string, EnvironmentOverride>>();
  for (const key of DEFAULT_ENVIRONMENTS) {
    environments.set(key, {
      key,
      displayName: key[0]!.toUpperCase() + key.slice(1),
      createdAt: new Date().toISOString(),
    });
  }

  return {
    list() {
      return [...environments.values()];
    },

    create(key, displayName) {
      if (environments.has(key)) return undefined;
      const environment: Environment = {
        key,
        displayName: displayName ?? key,
        createdAt: new Date().toISOString(),
      };
      environments.set(key, environment);
      return environment;
    },

    has(key) {
      return environments.has(key);
    },

    override(flagKey, environment) {
      return overrides.get(flagKey)?.get(environment);
    },

    overrides(flagKey) {
      return [...(overrides.get(flagKey)?.values() ?? [])];
    },

    setOverride(flagKey, environment, value) {
      const forFlag = overrides.get(flagKey) ?? new Map();
      const override: EnvironmentOverride = { environment, ...value };
      forFlag.set(environment, override);
      overrides.set(flagKey, forFlag);
      return override;
    },

    clearOverride(flagKey, environment) {
      return overrides.get(flagKey)?.delete(environment) ?? false;
    },

    clearFlag(flagKey) {
      overrides.delete(flagKey);
    },
  };
}
