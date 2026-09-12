import { REQUIRED_VERIFICATION_CHECKS } from '../src/evidence.js';
import { EMPTY_USAGE, type ModelAdapter, type ModelMessage, type ModelTurn, type ModelUsage, type ToolCall, type ToolDefinition } from '../src/model.js';
import { LeaseLostError, WorkerError } from '../src/errors.js';
import type { ControlPlane } from '../src/client.js';
import type { ClaimedJob, Evidence, Grant, JobOutcome, PublishedArtifact, Scope, UsageReservation } from '../src/types.js';

export const PRIVATE_SCOPE: Scope = { visibility: 'private', teamId: null, agentIds: [] };

export function makeManifest(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    agent: { id: 'agent-1', name: 'Research Lead', type: 'employee' },
    organization: { teamId: 'team-research', managerId: 'human-ceo', managerKind: 'human', reports: [] },
    role: { title: 'Research Lead' },
    mission: { primary: 'Produce verified research.' },
    responsibilities: ['Review approved briefs'],
    successMetrics: ['Evidence-backed reports'],
    runtime: { model: 'test-model', executionEnvironment: 'sandboxed' },
    tools: ['workspace-files', 'request_hire'],
    permissions: [
      { tool: 'workspace-files', operations: ['read', 'write', 'list'], resource: null, credentialRef: null },
      { tool: 'request_hire', operations: ['request'], resource: null, credentialRef: null },
    ],
    memory: { working: true, episodic: true, semantic: true, canonical: true },
    learning: { enabled: true, cadence: 'daily', autonomousChanges: ['episodic observations'], approvalRequiredChanges: ['canonical policy'] },
    escalation: { managerId: 'human-ceo', triggers: ['missing evidence'], defaultSeverity: 'medium' },
    budget: { modelCallsDaily: 20, externalSpendDaily: 5, currency: 'USD', maxConcurrentTasks: 2 },
    observability: { logs: true, traces: true, metrics: true },
    standards: ['Cite persisted evidence.'],
    communication: { allowedAgentIds: [], canContactManager: true, canContactHuman: true },
    context: { companyMission: 'Build a reliable organization.', teamMission: 'Produce verifiable research.', canonicalMemoryIds: [] },
    evaluation: { criteria: ['Every claim cites a source.'], requiredVerificationChecks: [...REQUIRED_VERIFICATION_CHECKS] },
    consultant: null,
    ...overrides,
  };
}

export function makeAgent(overrides: Record<string, unknown> = {}): Record<string, any> {
  return { id: 'agent-1', organizationId: 'org-demo', manifest: makeManifest(), status: 'ACTIVE', ...overrides };
}

export function makeJob(kind: ClaimedJob['kind'], payload: Record<string, unknown>, overrides: Record<string, unknown> = {}): ClaimedJob {
  return {
    jobId: `job-${kind}`,
    kind,
    payloadVersion: 1,
    organizationId: 'org-demo',
    agentId: 'agent-1',
    taskId: null,
    metaAgentId: 'meta-factory',
    hiringRequestId: 'hire-1',
    inputMessageId: null,
    idempotencyKey: `idem-${kind}`,
    attempt: 1,
    leaseToken: 'lease-token',
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    payload,
    ...overrides,
  } as ClaimedJob;
}

interface RecordedEvent { id: string; agentId: string | null; jobId: string | null; attempt: number | null; type: string; message: string; data: Record<string, unknown> }
interface RecordedArtifact { id: string; agentId: string | null; jobId: string | null; attempt: number | null; path: string; sha256: string; size: number }

/** In-memory stand-in for the control plane that enforces the contract's fencing and evidence rules. */
export class FakeControlPlane implements ControlPlane {
  readonly queue: ClaimedJob[] = [];
  readonly events: RecordedEvent[] = [];
  readonly artifacts: RecordedArtifact[] = [];
  readonly reservations = new Map<string, { id: string; jobId: string; attempt: number; modelCalls: number; status: 'RESERVED' | 'SETTLED' }>();
  readonly memories: Record<string, any>[] = [];
  readonly hires: Record<string, any>[] = [];
  readonly messages: Record<string, any>[] = [];
  readonly escalations: Record<string, any>[] = [];
  readonly completed: { job: ClaimedJob; outcome: JobOutcome; order: number }[] = [];
  readonly failed: { job: ClaimedJob; code: string; message: string; retryable: boolean; order: number }[] = [];
  readonly ops: string[] = [];
  /** Live grants a run_task/learn attempt observes through getAgent. */
  grants: Grant[] = [
    { tool: 'workspace-files', operations: ['read', 'write', 'list'], resource: null, credentialRef: null },
    { tool: 'request_hire', operations: ['request'], resource: null, credentialRef: null },
  ];
  agentState: Record<string, any> = { cancellationRequested: false, active: true };
  /** Prior visible memory used to ground learning. */
  memoryEntries: Record<string, any>[] = [];
  rejectForgedCredential = true;
  renewError: Error | null = null;
  /** Set to fail scoped memory retrieval; the worker must fail closed, not proceed. */
  memoryError: Error | null = null;
  /** Set to refuse the dedicated provisioning-verification capability (fail-closed coverage). */
  provisionCommunicationError: Error | null = null;
  readonly provisioningCommunications: { messageId: string; escalationId: string }[] = [];
  private sequence = 0;

  private nextId(prefix: string): string {
    return `${prefix}-${++this.sequence}`;
  }

  private scopeMatches(job: ClaimedJob, record: { agentId: string | null; jobId: string | null; attempt: number | null }): boolean {
    return record.agentId === job.agentId && record.jobId === job.jobId && record.attempt === job.attempt;
  }

  /** Mirrors the API's evidence resolution so tests cannot fabricate references. */
  assertEvidence(job: ClaimedJob, evidence: Evidence): void {
    if (!evidence.summary.trim() || evidence.artifactIds.length + evidence.eventIds.length === 0) {
      throw new WorkerError('EVIDENCE_REQUIRED', 'Completion requires a summary and persisted references');
    }
    for (const id of evidence.artifactIds) {
      const artifact = this.artifacts.find(candidate => candidate.id === id);
      if (!artifact || !this.scopeMatches(job, artifact)) throw new WorkerError('EVIDENCE_SCOPE', `Artifact ${id} is outside the attempt`);
    }
    for (const id of evidence.eventIds) {
      const event = this.events.find(candidate => candidate.id === id);
      if (!event || !this.scopeMatches(job, event)) throw new WorkerError('EVIDENCE_SCOPE', `Event ${id} is outside the attempt`);
    }
  }

  async claim(): Promise<ClaimedJob | null> {
    this.ops.push('claim');
    return this.queue.shift() ?? null;
  }

  async renew(): Promise<{ leaseExpiresAt: string }> {
    this.ops.push('renew');
    if (this.renewError) throw this.renewError;
    return { leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() };
  }

  async getAgent<T>(_job: ClaimedJob, agentId: string): Promise<T> {
    this.ops.push('getAgent');
    return {
      agent: { id: agentId, ...this.agentState },
      grants: this.agentState.cancellationRequested ? [] : this.grants,
      resources: [],
      verification: [],
    } as T;
  }

  async listMemory(_job: ClaimedJob, limit = 50): Promise<Record<string, any>[]> {
    this.ops.push('listMemory');
    if (this.memoryError) throw this.memoryError;
    return this.memoryEntries.slice(0, limit);
  }

  async probeUnauthorized(): Promise<boolean> {
    this.ops.push('probeUnauthorized');
    return this.rejectForgedCredential;
  }

  async appendEvent(job: ClaimedJob, input: { type: string; message: string; data: Record<string, unknown> }): Promise<{ id: string }> {
    this.ops.push('appendEvent');
    if ((input.type.startsWith('model.') || input.type.startsWith('tool.')) && !this.hasReservation(job)) {
      throw new WorkerError('RESERVATION_REQUIRED', 'Reserve budget before recording model or tool execution', false);
    }
    const id = this.nextId('event');
    this.events.push({ id, agentId: job.agentId, jobId: job.jobId, attempt: job.attempt, ...input });
    return { id };
  }

  async publishArtifact(job: ClaimedJob, input: { path: string; contentType: string; size: number; sha256: string; scope: Scope }): Promise<PublishedArtifact> {
    this.ops.push('publishArtifact');
    const id = this.nextId('artifact');
    this.artifacts.push({ id, agentId: job.agentId, jobId: job.jobId, attempt: job.attempt, path: input.path, sha256: input.sha256, size: input.size });
    return { id, path: input.path, sha256: input.sha256, size: input.size, contentType: input.contentType };
  }

  async reserveBudget(job: ClaimedJob, input: { modelCalls: number; cost: number; currency: string }): Promise<UsageReservation> {
    this.ops.push('reserveBudget');
    const id = this.nextId('reservation');
    this.reservations.set(id, { id, jobId: job.jobId, attempt: job.attempt, modelCalls: input.modelCalls, status: 'RESERVED' });
    return { id, modelCalls: input.modelCalls, status: 'RESERVED' };
  }

  async settleBudget(job: ClaimedJob, input: { reservationId: string; modelCalls: number }): Promise<UsageReservation> {
    this.ops.push('settleBudget');
    const reservation = this.reservations.get(input.reservationId);
    if (!reservation || reservation.jobId !== job.jobId || reservation.attempt !== job.attempt) {
      throw new WorkerError('RESERVATION_SCOPE', 'Reservation belongs to another attempt', false);
    }
    if (input.modelCalls > reservation.modelCalls) throw new WorkerError('BUDGET_OVERRUN', 'Settlement exceeds the reservation', false);
    reservation.status = 'SETTLED';
    return { id: reservation.id, modelCalls: input.modelCalls, status: 'SETTLED' };
  }

  async complete(job: ClaimedJob, outcome: JobOutcome): Promise<{ jobId: string; status: string; duplicate: boolean }> {
    this.ops.push('completeJob');
    if (outcome.kind !== 'retire_agent' && !this.settledWithoutOutstanding(job)) {
      throw new WorkerError('USAGE_SETTLEMENT_REQUIRED', 'Execution requires settled usage for this attempt', false);
    }
    if (outcome.kind === 'run_task') this.assertEvidence(job, outcome.evidence);
    if (outcome.kind === 'provision_agent' || outcome.kind === 'reconfigure_agent') {
      for (const step of outcome.steps) if (step.evidence) this.assertEvidence(job, step.evidence);
      for (const check of outcome.checks) this.assertEvidence(job, check.evidence);
    }
    if (outcome.kind === 'learn') this.assertEvidence(job, outcome.learning.evidence);
    if (outcome.kind === 'retire_agent') this.assertEvidence(job, outcome.evidence);
    this.completed.push({ job, outcome, order: this.ops.length });
    return { jobId: job.jobId, status: 'COMPLETED', duplicate: false };
  }

  async fail(job: ClaimedJob, input: { code: string; message: string; retryable: boolean; evidence: Evidence | null }): Promise<{ jobId: string; status: string; duplicate: boolean }> {
    this.ops.push('failJob');
    if (input.evidence) this.assertEvidence(job, input.evidence);
    this.failed.push({ job, code: input.code, message: input.message, retryable: input.retryable, order: this.ops.length });
    return { jobId: job.jobId, status: input.retryable ? 'QUEUED' : 'FAILED', duplicate: false };
  }

  /**
   * Contract 1.1.0 fenced provisioning-verification capability. Mirrors the API:
   * accepted only while a provisioning/reconfiguration lease is live, and it binds
   * the agent, manifest, recipients and content server-side, so there is no body
   * to supply beyond the lease. Ordinary pre-ACTIVE delegation stays forbidden.
   */
  async verifyProvisionCommunication(job: ClaimedJob): Promise<{ message: { id: string }; escalation: { id: string } }> {
    this.ops.push('verifyProvisionCommunication');
    if (this.provisionCommunicationError) throw this.provisionCommunicationError;
    if (!['provision_agent', 'reconfigure_agent'].includes(job.kind)) {
      throw new WorkerError('DELEGATION_FORBIDDEN', 'Communication verification requires a provisioning or reconfiguration job', false);
    }
    const messageId = this.nextId('message');
    const escalationId = this.nextId('escalation');
    this.messages.push({ id: messageId, agentId: job.agentId, attempt: job.attempt, serverBound: true, actionable: false });
    this.escalations.push({ id: escalationId, agentId: job.agentId, attempt: job.attempt, source: 'provisioning_verification', severity: 'low' });
    this.provisioningCommunications.push({ messageId, escalationId });
    return { message: { id: messageId }, escalation: { id: escalationId } };
  }

  async asAgent<T>(job: ClaimedJob, operationId: string, _path: string, body: Record<string, any>): Promise<T> {
    this.ops.push(operationId);
    if (operationId === 'createMemory') {
      const id = this.nextId('memory');
      const status = body.category === 'canonical' ? 'PROPOSED' : 'ACTIVE';
      this.memories.push({ id, agentId: job.agentId, attempt: job.attempt, ...body, status });
      return { id, status } as T;
    }
    if (operationId === 'createHiringRequest') {
      const id = this.nextId('hire');
      this.hires.push({ id, requestingAgentId: job.agentId, ...body });
      return { id } as T;
    }
    if (operationId === 'createMessage' || operationId === 'createEscalation') {
      // Faithful to apps/api/src/app.ts: ordinary delegation is admitted only for
      // run_task and learn jobs, and the delegated actor must be ACTIVE. A
      // provisioning job is therefore always refused, so no test can pass a
      // forbidden path; the dedicated 1.1.0 capability above is the only route.
      if (!['run_task', 'learn'].includes(job.kind)) {
        throw new WorkerError('DELEGATION_FORBIDDEN', 'Only agent task or learning execution may act as an agent', false);
      }
      if (!this.agentState.active) throw new WorkerError('AGENT_INACTIVE', 'Only ACTIVE agents may start work', false);
      if (operationId === 'createMessage') {
        const id = this.nextId('message');
        this.messages.push({ id, agentId: job.agentId, attempt: job.attempt, ...body });
        return { id } as T;
      }
      const id = this.nextId('escalation');
      this.escalations.push({ id, agentId: job.agentId, attempt: job.attempt, ...body });
      return { id } as T;
    }
    throw new Error(`Unexpected delegated operation ${operationId}`);
  }

  private hasReservation(job: ClaimedJob): boolean {
    return [...this.reservations.values()].some(reservation => reservation.jobId === job.jobId && reservation.attempt === job.attempt && reservation.status === 'RESERVED');
  }

  private settledWithoutOutstanding(job: ClaimedJob): boolean {
    const forAttempt = [...this.reservations.values()].filter(reservation => reservation.jobId === job.jobId && reservation.attempt === job.attempt);
    return forAttempt.some(reservation => reservation.status === 'SETTLED') && !forAttempt.some(reservation => reservation.status === 'RESERVED');
  }
}

export interface ScriptedTurn {
  content?: string | null;
  toolCalls?: ToolCall[];
  usage?: Partial<ModelUsage>;
}

export class FakeModel implements ModelAdapter {
  readonly name = 'test-model';
  readonly calls: { system: string; messages: ModelMessage[]; tools: ToolDefinition[] }[] = [];
  /** Number of in-flight provider requests cancelled by the lease signal. */
  abortedTurns = 0;
  private readonly turns: ScriptedTurn[];

  constructor(
    turns: ScriptedTurn[] | ((input: { system: string; messages: ModelMessage[] }) => ScriptedTurn),
    private readonly options: { delayMs?: number } = {},
  ) {
    this.turns = typeof turns === 'function' ? [] : turns;
    this.dynamic = typeof turns === 'function' ? turns : null;
  }

  private dynamic: ((input: { system: string; messages: ModelMessage[] }) => ScriptedTurn) | null;

  async turn(input: { system: string; messages: ModelMessage[]; tools?: ToolDefinition[]; signal?: AbortSignal }): Promise<ModelTurn> {
    if (this.options.delayMs) {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => { input.signal?.removeEventListener('abort', onAbort); resolvePromise(); }, this.options.delayMs);
        const onAbort = () => {
          clearTimeout(timer);
          this.abortedTurns++;  // the provider request is cancelled, so no further spend
          rejectPromise(new LeaseLostError(409, 'fake model cancelled by lease loss'));
        };
        if (input.signal?.aborted) { onAbort(); return; }
        input.signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    this.calls.push({ system: input.system, messages: input.messages, tools: input.tools ?? [] });
    const next = this.dynamic ? this.dynamic(input) : this.turns.shift();
    if (!next) throw new WorkerError('MODEL_CALL_FAILED', 'fake model ran out of scripted turns', false);
    return {
      content: next.content ?? null,
      toolCalls: next.toolCalls ?? [],
      usage: { ...EMPTY_USAGE, modelCalls: 1, inputTokens: 10, outputTokens: 5, ...(next.usage ?? {}) },
    };
  }
}

export class UnavailableModel implements ModelAdapter {
  readonly name = 'test-model';
  async turn(): Promise<ModelTurn> {
    throw new WorkerError('MODEL_UNAVAILABLE', 'OPENAI_API_KEY is not configured', false);
  }
}
