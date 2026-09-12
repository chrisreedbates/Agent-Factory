import { WorkerError } from './errors.js';
import type { Evidence } from './types.js';

/** Mandatory verification names required by the shared contract for provisioning. */
export const REQUIRED_VERIFICATION_CHECKS = [
  'runtime', 'model', 'tools', 'authentication', 'permissions', 'memory',
  'communication', 'escalation', 'observability', 'evaluation', 'restart', 'end_to_end',
] as const;

export function makeEvidence(input: {
  artifactIds?: string[];
  eventIds?: string[];
  taskId: string | null;
  jobId: string;
  summary: string;
}): Evidence {
  const artifactIds = [...new Set(input.artifactIds ?? [])];
  const eventIds = [...new Set(input.eventIds ?? [])];
  if (!input.summary.trim()) throw new WorkerError('EVIDENCE_REQUIRED', 'Evidence requires a nonempty summary');
  if (artifactIds.length + eventIds.length === 0) {
    throw new WorkerError('EVIDENCE_REQUIRED', 'Evidence requires at least one persisted artifact or event reference');
  }
  return { artifactIds, eventIds, taskId: input.taskId, jobId: input.jobId, summary: input.summary };
}

export function succeededCheck(name: string, evidence: Evidence): { name: string; passed: true; evidence: Evidence; error: null } {
  return { name, passed: true, evidence, error: null };
}
