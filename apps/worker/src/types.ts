import type { Job } from '@agent-factory/contracts';

export type WorkerJobKind =
  | 'compile_manifest'
  | 'provision_agent'
  | 'reconfigure_agent'
  | 'run_task'
  | 'learn'
  | 'retire_agent';

export const WORKER_JOB_KINDS: readonly WorkerJobKind[] = [
  'compile_manifest',
  'provision_agent',
  'reconfigure_agent',
  'run_task',
  'learn',
  'retire_agent',
];

/** The six fenced worker payloads, discriminated by the claimed job kind. */
export type JobPayload =
  | { hiringRequest: Record<string, any>; agent: Record<string, any>; organization: Record<string, any>; teams: Record<string, any>[] }
  | { agent: Record<string, any>; manifest: Record<string, any>; manifestVersion: number }
  | { agent: Record<string, any>; task: Record<string, any>; inputMessage: Record<string, any> | null }
  | { agent: Record<string, any> }
  | { agent: Record<string, any>; reason: string };

export type ClaimedJob = Job & { payload: JobPayload };

export interface Lease {
  leaseToken: string;
  attempt: number;
}

export interface Scope {
  visibility: 'private' | 'team' | 'organization';
  teamId: string | null;
  agentIds: string[];
}

export interface Evidence {
  artifactIds: string[];
  eventIds: string[];
  taskId: string | null;
  jobId: string | null;
  summary: string;
}

export interface VerificationCheck {
  name: string;
  passed: boolean;
  evidence: Evidence;
  error: string | null;
}

export interface ProvisioningStep {
  name: string;
  status: 'PENDING' | 'RUNNING' | 'PASSED' | 'FAILED';
  evidence: Evidence | null;
  error: string | null;
}

export interface Resource {
  id: string;
  organizationId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  agentId: string;
  type: 'workspace' | 'runtime' | 'credential' | 'tool' | 'queue' | 'schedule';
  reference: string;
  status: 'AVAILABLE' | 'UNAVAILABLE' | 'REVOKED';
  grants: Grant[];
  verification: VerificationCheck | null;
}

export interface Grant {
  tool: string;
  operations: string[];
  resource: string | null;
  credentialRef: string | null;
}

export type JobOutcome =
  | { kind: 'compile_manifest'; manifest: Record<string, any> }
  | { kind: 'provision_agent' | 'reconfigure_agent'; steps: ProvisioningStep[]; checks: VerificationCheck[]; resources: Resource[] }
  | { kind: 'run_task'; evidence: Evidence; summary: string; reply: string | null }
  | { kind: 'learn'; learning: { observation: string; hypothesis: string; conclusion: string; evidence: Evidence; memoryIds: string[]; canonicalRevisionId: string | null } }
  | { kind: 'retire_agent'; evidence: Evidence; credentialsRevoked: boolean; runtimeDisabled: boolean; knowledgePreserved: boolean; activeTasksResolved: boolean };

/** Persisted artifact metadata returned by `publishArtifact`. */
export interface PublishedArtifact {
  id: string;
  path: string;
  sha256: string;
  size: number;
  contentType: string;
}

export interface UsageReservation {
  id: string;
  modelCalls: number;
  status: 'RESERVED' | 'SETTLED' | 'RELEASED';
}
