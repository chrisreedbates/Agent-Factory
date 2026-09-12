import { createHash } from 'node:crypto';
import { LeaseLostError, WorkerError, isRecord } from './errors.js';
import type { WorkerConfig } from './config.js';
import type { ClaimedJob, Evidence, JobOutcome, Lease, PublishedArtifact, Scope, UsageReservation } from './types.js';

const FENCING_CODES = new Set(['STALE_LEASE', 'VERSION_CONFLICT']);

/** Stable JSON so retries of the same content reuse one idempotency key. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

interface RequestInput {
  method?: 'GET' | 'POST';
  body?: unknown;
  lease?: Lease;
  jobId?: string;
  /** Send the lease as delegation headers so the caller acts as the running agent. */
  delegated?: boolean;
  /** Omit the idempotency key for claim/renew, which the contract exempts. */
  idempotencyKey?: string | null;
}

/** The worker-facing surface of the control plane, injectable for tests. */
export type ControlPlane = Pick<
  ControlPlaneClient,
  'claim' | 'renew' | 'appendEvent' | 'publishArtifact' | 'reserveBudget' | 'settleBudget' | 'complete' | 'fail' | 'asAgent'
  | 'getAgent' | 'listMemory' | 'probeUnauthorized' | 'verifyProvisionCommunication'
>;

export class ControlPlaneClient {
  constructor(private readonly config: WorkerConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  private idempotencyKey(operationId: string, jobId: string | undefined, input: RequestInput): string | undefined {
    if (input.idempotencyKey === null) return undefined;
    if (input.idempotencyKey !== undefined) return input.idempotencyKey;
    const seed = digest({ operationId, jobId: jobId ?? null, attempt: input.lease?.attempt ?? null, body: input.body ?? null });
    return `w-${operationId}-${seed}`.slice(0, 200);
  }

  private async request<T>(operationId: string, path: string, input: RequestInput = {}): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.config.workerToken}`,
      accept: 'application/json',
    };
    if (input.body !== undefined) headers['content-type'] = 'application/json';
    const key = this.idempotencyKey(operationId, input.jobId, input);
    if (key) headers['idempotency-key'] = key;
    if (input.delegated) {
      if (!input.lease || !input.jobId) throw new Error('Delegated calls require a job lease');
      headers['x-job-id'] = input.jobId;
      headers['x-lease-token'] = input.lease.leaseToken;
      headers['x-job-attempt'] = String(input.lease.attempt);
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.apiBaseUrl}${path}`, {
        method: input.method ?? 'POST',
        headers,
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
    } catch (error) {
      throw new WorkerError('CONTROL_PLANE_UNAVAILABLE', `Control plane request failed: ${(error as Error).message}`, true);
    }
    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new WorkerError('CONTROL_PLANE_INVALID_RESPONSE', `Control plane returned non-JSON (${response.status})`, true);
      }
    }
    if (!response.ok) {
      const error = isRecord(payload) && isRecord(payload.error) ? payload.error : {};
      const code = typeof error.code === 'string' ? error.code : `HTTP_${response.status}`;
      const message = typeof error.message === 'string' ? error.message : `Control plane rejected ${operationId}`;
      const retryable = error.retryable === true;
      if (FENCING_CODES.has(code)) throw new LeaseLostError(response.status, message);
      throw new WorkerError(code, message, retryable);
    }
    return (isRecord(payload) ? payload.data : undefined) as T;
  }

  claim(kinds: readonly string[], leaseSeconds: number): Promise<ClaimedJob | null> {
    return this.request<ClaimedJob | null>('claimJob', '/v1/worker/jobs/claim', {
      body: { kinds, leaseSeconds },
      idempotencyKey: null,
    });
  }

  renew(job: ClaimedJob, leaseSeconds: number): Promise<{ leaseExpiresAt: string }> {
    return this.request('renewJob', `/v1/worker/jobs/${encodeURIComponent(job.jobId)}/renew`, {
      body: { leaseToken: job.leaseToken, attempt: job.attempt, leaseSeconds },
      jobId: job.jobId,
      idempotencyKey: null,
    });
  }

  appendEvent(job: ClaimedJob, input: { type: string; message: string; data: Record<string, unknown> }): Promise<{ id: string }> {
    return this.request('appendJobEvent', `/v1/worker/jobs/${encodeURIComponent(job.jobId)}/events`, {
      body: { leaseToken: job.leaseToken, attempt: job.attempt, ...input },
      jobId: job.jobId,
      lease: job,
    });
  }

  publishArtifact(
    job: ClaimedJob,
    input: { path: string; contentType: string; size: number; sha256: string; scope: Scope },
  ): Promise<PublishedArtifact> {
    return this.request('publishArtifact', `/v1/worker/jobs/${encodeURIComponent(job.jobId)}/artifacts`, {
      body: { leaseToken: job.leaseToken, attempt: job.attempt, ...input },
      jobId: job.jobId,
      lease: job,
    });
  }

  reserveBudget(job: ClaimedJob, input: { modelCalls: number; cost: number; currency: string }): Promise<UsageReservation> {
    return this.request('reserveBudget', `/v1/worker/jobs/${encodeURIComponent(job.jobId)}/budget/reserve`, {
      body: { leaseToken: job.leaseToken, attempt: job.attempt, ...input },
      jobId: job.jobId,
      lease: job,
    });
  }

  settleBudget(
    job: ClaimedJob,
    input: { reservationId: string; modelCalls: number; inputTokens: number | null; outputTokens: number | null; cost: number | null },
  ): Promise<UsageReservation> {
    return this.request('settleBudget', `/v1/worker/jobs/${encodeURIComponent(job.jobId)}/budget/settle`, {
      body: { leaseToken: job.leaseToken, attempt: job.attempt, ...input },
      jobId: job.jobId,
      lease: job,
    });
  }

  complete(job: ClaimedJob, outcome: JobOutcome): Promise<{ jobId: string; status: string; duplicate: boolean }> {
    return this.request('completeJob', `/v1/worker/jobs/${encodeURIComponent(job.jobId)}/complete`, {
      body: { leaseToken: job.leaseToken, attempt: job.attempt, outcome },
      jobId: job.jobId,
      lease: job,
    });
  }

  fail(
    job: ClaimedJob,
    input: { code: string; message: string; retryable: boolean; evidence: Evidence | null },
  ): Promise<{ jobId: string; status: string; duplicate: boolean }> {
    return this.request('failJob', `/v1/worker/jobs/${encodeURIComponent(job.jobId)}/fail`, {
      body: { leaseToken: job.leaseToken, attempt: job.attempt, ...input },
      jobId: job.jobId,
      lease: job,
    });
  }

  /** A delegated agent-capable call performed under the current run_task/learn lease. */
  asAgent<T>(job: ClaimedJob, operationId: string, path: string, body: unknown): Promise<T> {
    return this.request<T>(operationId, path, { body, jobId: job.jobId, lease: job, delegated: true });
  }

  /**
   * Fenced provisioning communication verification (contract 1.1.0). Exercises the
   * durable manager message and escalation paths during a current
   * `provision_agent`/`reconfigure_agent` lease. The API binds the agent, approved
   * manifest, recipients and content server-side, so the worker sends only its
   * lease token and attempt: no delegated agent headers, recipients or content.
   */
  verifyProvisionCommunication(job: ClaimedJob): Promise<{ message: { id: string }; escalation: { id: string } }> {
    return this.request('verifyProvisionCommunication', `/v1/worker/jobs/${encodeURIComponent(job.jobId)}/verify-communication`, {
      body: { leaseToken: job.leaseToken, attempt: job.attempt },
      jobId: job.jobId,
    });
  }

  /** Read the agent's live record and current grants under the active lease. */
  getAgent<T = { agent: Record<string, any>; grants: Record<string, any>[]; resources: Record<string, any>[]; verification: Record<string, any>[] }>(
    job: ClaimedJob,
    agentId: string,
  ): Promise<T> {
    return this.request<T>('getAgent', `/v1/agents/${encodeURIComponent(agentId)}`, {
      method: 'GET',
      jobId: job.jobId,
      lease: job,
      delegated: true,
    });
  }

  /** Read the agent's currently visible, scoped memory under the active lease. */
  listMemory(job: ClaimedJob, limit = 50): Promise<Record<string, any>[]> {
    return this.request<Record<string, any>[]>('listMemory', `/v1/memory?limit=${encodeURIComponent(String(limit))}`, {
      method: 'GET',
      jobId: job.jobId,
      lease: job,
      delegated: true,
    });
  }

  /**
   * Genuine authentication boundary probe: a forged worker credential must be
   * rejected with 401 while the real credential holds this lease. Returns true
   * only when the control plane denies the forged caller.
   */
  async probeUnauthorized(jobId: string): Promise<boolean> {
    const response = await this.fetchImpl(`${this.config.apiBaseUrl}/v1/worker/jobs/${encodeURIComponent(jobId)}/renew`, {
      method: 'POST',
      headers: { authorization: `Bearer ${'forged-credential-'.padEnd(32, 'x')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ leaseToken: 'forged-lease', attempt: 1, leaseSeconds: 60 }),
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });
    return response.status === 401;
  }
}
