import { resolve } from 'node:path';
import { WORKER_JOB_KINDS, type WorkerJobKind } from './types.js';

export interface WorkerConfig {
  /** Base URL of the shared control plane, e.g. http://127.0.0.1:3000 */
  apiBaseUrl: string;
  /** Distinct worker credential. Never the operator token. */
  workerToken: string;
  organizationId: string;
  workerPrincipalId: string;
  /** Read/write root for immutable job artifacts. */
  artifactRoot: string;
  /** Read-only directory of approved source briefs. */
  sourceRoot: string;
  /** The single configurable model identity used by every agent. */
  modelName: string;
  modelApiKey: string | null;
  modelBaseUrl: string | null;
  currency: string;
  leaseSeconds: number;
  pollIntervalMs: number;
  requestTimeoutMs: number;
  /** Reservation amount per model call; settlement always records the real cost or null. */
  estimatedCostPerCall: number;
  /** Cap on model/tool round trips for a single task execution. */
  maxToolRounds: number;
  jobKinds: readonly WorkerJobKind[];
}

const DEFAULT_API = 'http://127.0.0.1:3000';
const DEFAULT_ARTIFACT_ROOT = './artifacts';
const DEFAULT_SOURCE_ROOT = './sources';
const DEFAULT_CURRENCY = 'USD';
const DEFAULT_LEASE_SECONDS = 120;
const DEFAULT_POLL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_ESTIMATED_COST = 0.05;
const DEFAULT_MAX_TOOL_ROUNDS = 8;

const integer = (env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number => {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
};

const decimal = (env: NodeJS.ProcessEnv, name: string, fallback: number): number => {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
  return value;
};

/**
 * The worker never reads PostgreSQL and never invents credentials. A missing
 * model key is a configuration error surfaced at call time as MODEL_UNAVAILABLE,
 * not a silently successful run.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const workerToken = env.WORKER_TOKEN ?? '';
  if (workerToken.length < 32) {
    throw new Error('WORKER_TOKEN must be configured with at least 32 characters');
  }
  const modelName = (env.MODEL_NAME ?? '').trim();
  if (!modelName) throw new Error('MODEL_NAME must name the configured runtime model');
  const currency = (env.CURRENCY ?? DEFAULT_CURRENCY).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('CURRENCY must be a three-letter ISO code');
  const kinds = (env.WORKER_JOB_KINDS ?? WORKER_JOB_KINDS.join(','))
    .split(',')
    .map(kind => kind.trim())
    .filter(Boolean);
  if (!kinds.length || kinds.some(kind => !WORKER_JOB_KINDS.includes(kind as WorkerJobKind))) {
    throw new Error(`WORKER_JOB_KINDS must be a subset of ${WORKER_JOB_KINDS.join(', ')}`);
  }
  return {
    apiBaseUrl: (env.API_BASE_URL ?? DEFAULT_API).replace(/\/+$/, ''),
    workerToken,
    organizationId: env.ORGANIZATION_ID ?? 'org-demo',
    workerPrincipalId: env.WORKER_PRINCIPAL_ID ?? 'worker-local',
    artifactRoot: resolve(env.ARTIFACT_ROOT ?? DEFAULT_ARTIFACT_ROOT),
    sourceRoot: resolve(env.SOURCE_ROOT ?? DEFAULT_SOURCE_ROOT),
    modelName,
    modelApiKey: env.OPENAI_API_KEY?.trim() ? env.OPENAI_API_KEY.trim() : null,
    modelBaseUrl: env.OPENAI_BASE_URL?.trim() ? env.OPENAI_BASE_URL.trim() : null,
    currency,
    leaseSeconds: integer(env, 'WORKER_LEASE_SECONDS', DEFAULT_LEASE_SECONDS, 10, 300),
    pollIntervalMs: integer(env, 'WORKER_POLL_MS', DEFAULT_POLL_MS, 250, 60_000),
    requestTimeoutMs: integer(env, 'WORKER_REQUEST_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 1_000, 600_000),
    estimatedCostPerCall: decimal(env, 'WORKER_ESTIMATED_COST_PER_CALL', DEFAULT_ESTIMATED_COST),
    maxToolRounds: integer(env, 'WORKER_MAX_TOOL_ROUNDS', DEFAULT_MAX_TOOL_ROUNDS, 1, 12),
    jobKinds: kinds as WorkerJobKind[],
  };
}
