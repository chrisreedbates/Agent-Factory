import type { ControlPlane } from './client.js';
import type { WorkerConfig } from './config.js';
import { LeaseLostError, WorkerError } from './errors.js';
import { ModelCallError } from './model.js';
import { JobLedger, type JobRunner } from './handlers.js';
import type { ClaimedJob } from './types.js';

/**
 * Tracks whether the worker still holds the attempt. Handlers call `assertLive`
 * before every model call, tool operation and publish so a lost or expired lease
 * stops further spend and filesystem effects instead of continuing silently.
 */
export interface LeaseGuard {
  readonly signal: AbortSignal;
  readonly lost: boolean;
  assertLive(): void;
  update(leaseExpiresAt: string): void;
  lose(reason: string): void;
}

export function createLeaseGuard(job: ClaimedJob, onLost?: (reason: string) => void): LeaseGuard {
  const controller = new AbortController();
  let expiresAt = Date.parse(job.leaseExpiresAt);
  let lost = false;
  const lose = (reason: string): void => {
    if (lost) return;
    lost = true;
    controller.abort();
    onLost?.(reason);
  };
  return {
    signal: controller.signal,
    get lost() {
      return lost;
    },
    assertLive() {
      if (lost) throw new LeaseLostError(409, 'The job lease was lost; the attempt is abandoned');
      if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
        lose('The job lease expired locally');
        throw new LeaseLostError(409, 'The job lease expired');
      }
    },
    update(leaseExpiresAt: string) {
      const parsed = Date.parse(leaseExpiresAt);
      if (Number.isFinite(parsed)) expiresAt = parsed;
    },
    lose,
  };
}

export interface WorkerRuntimeOptions {
  config: WorkerConfig;
  client: ControlPlane;
  runner: JobRunner;
  log: (message: string, data?: Record<string, unknown>) => void;
  /** Tests disable renewal so the poll loop stays deterministic. */
  enableRenewal?: boolean;
  /** Tests can shorten the renewal interval to exercise lease loss. */
  renewIntervalMs?: number;
}

/** Polls the control plane, holds one job lease at a time and never self-activates an agent. */
export class WorkerRuntime {
  constructor(private readonly options: WorkerRuntimeOptions) {}

  /** Claim and execute at most one job. Returns false when no work is available. */
  async runOnce(): Promise<boolean> {
    const { config, client } = this.options;
    const job = await client.claim(config.jobKinds, config.leaseSeconds);
    if (!job) return false;
    this.options.log('claimed job', { jobId: job.jobId, kind: job.kind, attempt: job.attempt });
    await this.execute(job);
    return true;
  }

  private async execute(job: ClaimedJob): Promise<void> {
    const { config, client, runner, log } = this.options;
    const ledger = new JobLedger(client, job, config);
    const guard = createLeaseGuard(job, reason => log('lease lost; aborting attempt', { jobId: job.jobId, reason }));
    const timer = this.options.enableRenewal === false ? null : this.startRenewal(job, guard);
    try {
      await runner.run(job, ledger, guard);
      log('job completed', { jobId: job.jobId, kind: job.kind, modelCalls: ledger.usage.modelCalls });
    } catch (error) {
      if (error instanceof LeaseLostError || guard.lost) {
        log('attempt abandoned without reporting an outcome', { jobId: job.jobId, kind: job.kind });
        return;
      }
      const failure = error instanceof WorkerError ? error : new WorkerError('WORKER_FAILURE', (error as Error).message, false);
      log('job failed', { jobId: job.jobId, kind: job.kind, code: failure.code, retryable: failure.retryable });
      if (error instanceof ModelCallError) ledger.record(error.usage);
      // Release any reservation to the usage actually recorded, then report the failure.
      try {
        await ledger.settle();
      } catch (settleError) {
        log('could not settle reservation while failing', { jobId: job.jobId, error: (settleError as Error).message });
      }
      try {
        await client.fail(job, { code: failure.code, message: failure.message, retryable: failure.retryable, evidence: failure.evidence ?? null });
      } catch (reportError) {
        log('could not report job failure', { jobId: job.jobId, error: (reportError as Error).message });
      }
    } finally {
      if (timer) clearInterval(timer);
    }
  }

  private startRenewal(job: ClaimedJob, guard: LeaseGuard): NodeJS.Timeout {
    const interval = this.options.renewIntervalMs ?? Math.max(2_000, Math.floor((this.options.config.leaseSeconds * 1000) / 2));
    const timer = setInterval(() => {
      void this.options.client
        .renew(job, this.options.config.leaseSeconds)
        .then(result => guard.update(result.leaseExpiresAt))
        .catch((error: unknown) => {
          const reason = error instanceof LeaseLostError ? 'renewal was fenced by a newer attempt' : `renewal failed: ${(error as Error).message}`;
          guard.lose(reason);
        });
    }, interval);
    timer.unref?.();
    return timer;
  }

  /** Poll until aborted. Claim/transport errors back off rather than crashing the worker. */
  async runForever(signal: AbortSignal): Promise<void> {
    const { config, log } = this.options;
    let backoff = config.pollIntervalMs;
    while (!signal.aborted) {
      let worked = false;
      try {
        worked = await this.runOnce();
        backoff = config.pollIntervalMs;
      } catch (error) {
        backoff = Math.min(backoff * 2, 30_000);
        log('poll failed; backing off', { error: (error as Error).message, backoffMs: backoff });
      }
      if (!worked) await this.delay(backoff, signal);
    }
  }

  private delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise(resolvePromise => {
      if (signal.aborted) return resolvePromise();
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolvePromise();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolvePromise();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
