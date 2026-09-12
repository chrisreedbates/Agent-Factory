import type { ControlPlane } from './client.js';
import type { WorkerConfig } from './config.js';
import { LeaseLostError, WorkerError } from './errors.js';
import { JobLedger, type JobRunner } from './handlers.js';
import type { ClaimedJob } from './types.js';

export interface WorkerRuntimeOptions {
  config: WorkerConfig;
  client: ControlPlane;
  runner: JobRunner;
  log: (message: string, data?: Record<string, unknown>) => void;
  /** Tests disable renewal so the poll loop stays deterministic. */
  enableRenewal?: boolean;
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
    const timer = this.options.enableRenewal === false ? null : this.startRenewal(job);
    try {
      await runner.run(job, ledger);
      log('job completed', { jobId: job.jobId, kind: job.kind, modelCalls: ledger.usage.modelCalls });
    } catch (error) {
      if (error instanceof LeaseLostError) {
        log('lease lost; abandoning attempt', { jobId: job.jobId, kind: job.kind });
        return;
      }
      const failure = error instanceof WorkerError ? error : new WorkerError('WORKER_FAILURE', (error as Error).message, false);
      log('job failed', { jobId: job.jobId, kind: job.kind, code: failure.code, retryable: failure.retryable });
      // Release any reservation to the usage actually recorded, then report the failure.
      try {
        await ledger.settle();
      } catch (settleError) {
        log('could not settle reservation while failing', { jobId: job.jobId, error: (settleError as Error).message });
      }
      try {
        await client.fail(job, { code: failure.code, message: failure.message, retryable: failure.retryable, evidence: null });
      } catch (reportError) {
        log('could not report job failure', { jobId: job.jobId, error: (reportError as Error).message });
      }
    } finally {
      if (timer) clearInterval(timer);
    }
  }

  private startRenewal(job: ClaimedJob): NodeJS.Timeout {
    const interval = Math.max(2_000, Math.floor((this.options.config.leaseSeconds * 1000) / 2));
    const timer = setInterval(() => {
      this.options.client
        .renew(job, this.options.config.leaseSeconds)
        .catch(error => this.options.log('lease renewal failed', { jobId: job.jobId, error: (error as Error).message }));
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
