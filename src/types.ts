/**
 * Core domain types for Flagpole.
 *
 * A flag is uniquely identified by its `key`. Timestamps are ISO-8601
 * strings so flags serialize cleanly to JSON for both API responses and
 * the optional file-persistence layer.
 */

export interface Flag {
  /** Unique identifier, e.g. "new-checkout". Immutable after creation. */
  key: string;
  /** Human-readable note about what the flag controls. */
  description: string;
  /** Whether the flag is currently on. */
  enabled: boolean;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp of the last mutation. */
  updatedAt: string;
}

/** Fields accepted when creating a flag. */
export interface CreateFlagInput {
  key: string;
  description?: string;
  enabled: boolean;
}

/** Fields accepted when updating a flag. At least one must be present. */
export interface UpdateFlagInput {
  description?: string;
  enabled?: boolean;
}

/**
 * Uniform error envelope returned by every non-2xx response, so clients
 * can always read `error.code` / `error.message` regardless of endpoint.
 */
export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}
