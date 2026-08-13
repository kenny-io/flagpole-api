/**
 * Deterministic percentage-rollout bucketing.
 *
 * A unit (user id, session id, whatever the caller keys rollouts on) is
 * hashed together with the flag key into a bucket from 0 to 99. A flag with
 * `rolloutPercentage: N` is enabled for a unit exactly when its bucket is
 * below N — so the same unit always gets the same answer for the same flag,
 * and raising the percentage only ever adds units, never reshuffles them.
 *
 * The flag key is mixed into the hash so a given unit lands in independent
 * buckets across flags; otherwise the same ~N% of users would be the guinea
 * pigs for every rollout.
 *
 * FNV-1a is used because it is tiny, dependency-free, and plenty uniform
 * for bucketing. This is not a cryptographic boundary — units are not
 * secrets — but the constants must never change, or every in-flight rollout
 * would reshuffle its cohorts.
 */

/** 32-bit FNV-1a hash of a string. */
const fnv1a = (input: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply, kept in integer range via shifts.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
};

/** Map a (flag key, unit) pair to a stable bucket in [0, 100). */
export const rolloutBucket = (flagKey: string, unit: string): number =>
  fnv1a(`${flagKey}:${unit}`) % 100;

/**
 * Decide whether a flag is on for a given unit.
 *
 * `enabled` remains the master switch: a disabled flag is off for everyone
 * regardless of percentage, and a flag without a rolloutPercentage (or an
 * evaluation without a unit) falls back to the plain boolean.
 */
export const isEnabledForUnit = (
  flagKey: string,
  enabled: boolean,
  rolloutPercentage: number | undefined,
  unit: string | undefined,
): boolean => {
  if (!enabled) return false;
  if (rolloutPercentage === undefined || unit === undefined) return true;
  return rolloutBucket(flagKey, unit) < rolloutPercentage;
};
