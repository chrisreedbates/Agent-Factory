import type { Evidence } from './types.js';

/** A failure that can be reported to the control plane through `failJob`. */
export class WorkerError extends Error {
  /** Persisted diagnostic from this fenced attempt, when available. */
  evidence?: Evidence;
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'WorkerError';
  }
}

/** The lease is no longer ours; abandon the attempt without reporting a job failure. */
export class LeaseLostError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'LeaseLostError';
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
