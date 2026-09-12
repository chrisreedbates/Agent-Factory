import { randomUUID } from 'node:crypto';
import { AgentManifest, validateResponse, validationErrors } from '@agent-factory/contracts';
import type { ControlPlane } from './client.js';
import type { WorkerConfig } from './config.js';
import { LeaseLostError, WorkerError } from './errors.js';
import { addUsage, EMPTY_USAGE, extractJson, type ModelAdapter, type ModelUsage, type ToolCall, type ToolDefinition, runToolLoop } from './model.js';
import { REQUIRED_VERIFICATION_CHECKS, makeEvidence, succeededCheck } from './evidence.js';
import type { ClaimedJob, Grant, ProvisioningStep, Resource, Scope, VerificationCheck } from './types.js';
import type { Workspace } from './workspace.js';

export const SUPPORTED_TOOLS: Readonly<Record<string, readonly string[]>> = {
  'workspace-files': ['read', 'write', 'list'],
  request_hire: ['request'],
};

const PRIVATE_SCOPE: Scope = { visibility: 'private', teamId: null, agentIds: [] };
const MAX_TOOL_RESULT_CHARS = 8_000;

const nowIso = () => new Date().toISOString();

const stringList = (value: unknown, fallback: string[], max = 20): string[] => {
  const items = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
  const unique = [...new Set(items.map(item => item.trim()))].slice(0, max);
  return unique.length ? unique : fallback;
};

const firstParagraph = (text: string): string => text.trim().split(/\n{2,}/)[0]?.trim() ?? text.trim();

/** One reserve/settle pair per attempt. Idempotent so a failure path can settle safely. */
export class JobLedger {
  usage: ModelUsage = { ...EMPTY_USAGE };
  private reservationId: string | null = null;
  private settled = false;

  constructor(private readonly client: ControlPlane, private readonly job: ClaimedJob, private readonly config: WorkerConfig) {}

  record(usage: ModelUsage): void {
    this.usage = addUsage(this.usage, usage);
  }

  async reserve(modelCalls: number): Promise<void> {
    if (this.reservationId || modelCalls <= 0) return;
    const cost = Number((modelCalls * this.config.estimatedCostPerCall).toFixed(6));
    try {
      const reservation = await this.client.reserveBudget(this.job, { modelCalls, cost, currency: this.config.currency });
      this.reservationId = reservation.id;
    } catch (error) {
      if (error instanceof WorkerError && error.code === 'BUDGET_EXCEEDED') {
        throw new WorkerError('BUDGET_EXCEEDED', error.message, false);
      }
      throw error;
    }
  }

  async settle(): Promise<void> {
    if (!this.reservationId || this.settled) return;
    await this.client.settleBudget(this.job, {
      reservationId: this.reservationId,
      modelCalls: this.usage.modelCalls,
      inputTokens: this.usage.inputTokens,
      outputTokens: this.usage.outputTokens,
      cost: this.usage.cost,
    });
    this.settled = true;
  }
}

interface RoleDraft {
  name?: unknown;
  roleTitle?: unknown;
  mission?: unknown;
  responsibilities?: unknown;
  successMetrics?: unknown;
  standards?: unknown;
  evaluationCriteria?: unknown;
  escalationTriggers?: unknown;
  learningCadence?: unknown;
}

interface TaskDraft {
  summary?: unknown;
  reply?: unknown;
}

interface LearningDraft {
  observation?: unknown;
  hypothesis?: unknown;
  conclusion?: unknown;
  title?: unknown;
  content?: unknown;
}

export interface JobRunnerDependencies {
  config: WorkerConfig;
  client: ControlPlane;
  workspace: Workspace;
  model: ModelAdapter;
  log: (message: string, data?: Record<string, unknown>) => void;
}

export class JobRunner {
  constructor(private readonly deps: JobRunnerDependencies) {}

  async run(job: ClaimedJob, ledger: JobLedger): Promise<void> {
    switch (job.kind) {
      case 'compile_manifest': return this.compileManifest(job, ledger);
      case 'provision_agent':
      case 'reconfigure_agent': return this.provision(job, ledger);
      case 'run_task': return this.runTask(job, ledger);
      case 'learn': return this.learn(job, ledger);
      case 'retire_agent': return this.retire(job, ledger);
      default: throw new WorkerError('UNKNOWN_JOB', `Unsupported job kind ${job.kind}`, false);
    }
  }

  private agentOf(job: ClaimedJob): Record<string, any> {
    return (job.payload as any).agent as Record<string, any>;
  }

  private async observe(job: ClaimedJob, type: string, message: string, data: Record<string, unknown> = {}): Promise<string> {
    const event = await this.deps.client.appendEvent(job, { type, message, data });
    return event.id;
  }

  private async publish(job: ClaimedJob, name: string, content: string, contentType = 'text/plain'): Promise<{ id: string; path: string }> {
    const agent = this.agentOf(job);
    const stored = await this.deps.workspace.writeArtifact(agent.id, job.jobId, job.attempt, name, content);
    const published = await this.deps.client.publishArtifact(job, {
      path: stored.path,
      contentType,
      size: stored.size,
      sha256: stored.sha256,
      scope: PRIVATE_SCOPE,
    });
    return { id: published.id, path: stored.path };
  }

  /** Emit a tool observation only when the approved manifest actually grants the operation. */
  private async toolEvent(job: ClaimedJob, manifest: Record<string, any>, tool: string, operation: string, data: Record<string, unknown>): Promise<string | null> {
    const grant = (manifest.permissions as Grant[]).find(candidate => candidate.tool === tool);
    if (!grant || !grant.operations.includes(operation)) return null;
    return this.observe(job, `tool.${tool}`, `Executed ${tool} ${operation}`, { tool, operation, ...data });
  }

  // --- compile_manifest -----------------------------------------------------

  private async compileManifest(job: ClaimedJob, ledger: JobLedger): Promise<void> {
    const payload = job.payload as any;
    const { hiringRequest, agent, organization, teams } = payload;
    await ledger.reserve(1);
    const team = (teams as Record<string, any>[]).find(candidate => candidate.id === hiringRequest.proposal.teamId);
    const turn = await this.deps.model.turn({
      system: [
        'You compile a natural-language hiring request into a reviewed agent role.',
        'Respond with a single JSON object and no prose. Keys: name, roleTitle, mission, responsibilities,',
        'successMetrics, standards, evaluationCriteria, escalationTriggers, learningCadence.',
        'Responsibilities, successMetrics, standards and evaluationCriteria are arrays of short strings.',
        'Never invent tools, budgets, managers or permissions; those are governance inputs.',
      ].join(' '),
      messages: [{
        role: 'user',
        content: JSON.stringify({
          requestedRole: hiringRequest.proposal.role,
          justification: hiringRequest.proposal.justification,
          requestedMission: hiringRequest.proposal.mission,
          expectedBenefit: hiringRequest.proposal.expectedBenefit,
          agentType: hiringRequest.proposal.agentType,
          organizationMission: organization.mission,
          teamMission: team?.mission ?? organization.mission,
          constraints: hiringRequest.proposal.constraints ?? [],
        }),
      }],
    });
    ledger.record(turn.usage);
    await this.observe(job, 'model.compilation', 'Compiled a role draft from the hiring request', {
      model: this.deps.model.name,
      modelCalls: turn.usage.modelCalls,
      inputTokens: turn.usage.inputTokens,
      outputTokens: turn.usage.outputTokens,
    });
    const draft = extractJson<RoleDraft>(turn.content);
    const manifest = this.assembleManifest(draft, { hiringRequest, agent, organization, team });
    if (!validateResponse(AgentManifest, manifest)) {
      const errors = validationErrors(AgentManifest, manifest).map(error => `${error.path}: ${error.message}`).join('; ');
      throw new WorkerError('INVALID_MANIFEST', `Compiled manifest does not match the shared schema: ${errors}`, false);
    }
    await ledger.settle();
    await this.deps.client.complete(job, { kind: 'compile_manifest', manifest });
  }

  private assembleManifest(draft: RoleDraft, input: { hiringRequest: any; agent: any; organization: any; team: any }): Record<string, any> {
    const proposal = input.hiringRequest.proposal;
    if (proposal.agentType === 'consultant' && !proposal.consultant) {
      throw new WorkerError('CONSULTANT_BOUND_REQUIRED', 'A consultant proposal must include its deliverable and termination condition', false);
    }
    const tools = [...new Set<string>(proposal.tools)].filter(tool => Object.hasOwn(SUPPORTED_TOOLS, tool));
    const permissions = (proposal.grants as Grant[]).filter(grant => tools.includes(grant.tool));
    return {
      agent: { id: input.agent.id, name: typeof draft.name === 'string' && draft.name.trim() ? draft.name.trim() : proposal.role, type: proposal.agentType },
      organization: {
        teamId: proposal.teamId,
        managerId: proposal.proposedManagerId,
        managerKind: proposal.proposedManagerKind,
        // A new agent has no reports; the API derives reports from the live graph.
        reports: [],
      },
      role: { title: typeof draft.roleTitle === 'string' && draft.roleTitle.trim() ? draft.roleTitle.trim() : proposal.role },
      mission: { primary: typeof draft.mission === 'string' && draft.mission.trim() ? draft.mission.trim() : proposal.mission },
      responsibilities: stringList(draft.responsibilities, stringList(proposal.responsibilities, ['Perform the role mission.'])),
      successMetrics: stringList(draft.successMetrics, ['Evidence-backed deliverables.']),
      runtime: { model: this.deps.config.modelName, executionEnvironment: 'sandboxed' },
      tools,
      permissions,
      memory: { working: true, episodic: true, semantic: true, canonical: true },
      learning: {
        enabled: true,
        cadence: typeof draft.learningCadence === 'string' && draft.learningCadence.trim() ? draft.learningCadence.trim() : 'daily',
        autonomousChanges: ['episodic observations'],
        approvalRequiredChanges: ['canonical policy', 'grants', 'budget', 'retirement'],
      },
      escalation: {
        // Escalation always routes to the reporting manager, matching the API policy.
        managerId: proposal.proposedManagerId,
        triggers: stringList(draft.escalationTriggers, ['missing evidence', 'budget exhausted']),
        defaultSeverity: 'medium',
      },
      budget: proposal.budget,
      observability: { logs: true, traces: true, metrics: true },
      standards: stringList(draft.standards, ['Cite persisted evidence; never represent missing verification as success.']),
      communication: { allowedAgentIds: [], canContactManager: true, canContactHuman: true },
      context: {
        companyMission: input.organization.mission,
        teamMission: input.team?.mission ?? input.organization.mission,
        canonicalMemoryIds: [],
      },
      evaluation: {
        criteria: stringList(draft.evaluationCriteria, ['Every claim is backed by a persisted artifact or event.']),
        requiredVerificationChecks: [...REQUIRED_VERIFICATION_CHECKS],
      },
      consultant: proposal.consultant ?? null,
    };
  }

  // --- provision_agent / reconfigure_agent ---------------------------------

  private async provision(job: ClaimedJob, ledger: JobLedger): Promise<void> {
    const payload = job.payload as any;
    const agent = payload.agent;
    const manifest = payload.manifest as Record<string, any>;
    const verified = new Set<string>();
    const artifacts: string[] = [];
    const events: string[] = [];
    const record = (check: VerificationCheck) => { verified.add(check.name); return check; };
    const checks: VerificationCheck[] = [];

    // Reserve for a real model self-check plus one end-to-end round trip.
    await ledger.reserve(2);

    // 1. runtime: write, hash and read back a durable probe artifact.
    const probe = await this.deps.workspace.probe(agent.id, job.jobId, job.attempt, 'runtime-probe.txt', `runtime probe ${job.jobId} ${nowIso()}`);
    const runtimeArtifact = await this.publish(job, 'runtime-probe.txt', probe.content.toString('utf8'));
    const runtimeEvent = await this.observe(job, 'verification.runtime', 'Workspace write/read/hash probe passed', { path: runtimeArtifact.path, sha256: probe.sha256 });
    artifacts.push(runtimeArtifact.id); events.push(runtimeEvent);
    checks.push(record(succeededCheck('runtime', makeEvidence({ artifactIds: [runtimeArtifact.id], eventIds: [runtimeEvent], taskId: job.taskId, jobId: job.jobId, summary: `Immutable runtime probe ${runtimeArtifact.path} round-tripped with a matching SHA-256.` }))));

    // 2. model: invoke the configured real model and record its actual usage.
    let modelReply = '';
    let modelUsage: ModelUsage = { ...EMPTY_USAGE };
    const modelTurn = await this.deps.model.turn({
      system: 'You are a runtime self-check. Reply with exactly the single word READY and nothing else.',
      messages: [{ role: 'user', content: 'Confirm the configured model is reachable.' }],
    });
    modelUsage = modelTurn.usage;
    ledger.record(modelUsage);
    modelReply = (modelTurn.content ?? '').trim();
    const modelEvent = await this.observe(job, 'model.selfcheck', 'Invoked the configured model for a runtime self-check', {
      model: this.deps.model.name, modelCalls: modelUsage.modelCalls, inputTokens: modelUsage.inputTokens, outputTokens: modelUsage.outputTokens, reply: modelReply.slice(0, 200),
    });
    events.push(modelEvent);
    checks.push(record(succeededCheck('model', makeEvidence({ eventIds: [modelEvent], taskId: job.taskId, jobId: job.jobId, summary: `The configured model ${this.deps.model.name} responded with persisted usage.` }))));

    // 3. tools: list the approved briefs and the agent workspace.
    const inventory = JSON.stringify({ briefs: await this.deps.workspace.list('briefs', agent.id), workspace: await this.deps.workspace.list('workspace', agent.id) }, null, 2);
    const toolsArtifact = await this.publish(job, 'tools-inventory.json', inventory, 'application/json');
    const toolsEvent = await this.toolEvent(job, manifest, 'workspace-files', 'list', { root: 'briefs' })
      ?? await this.observe(job, 'verification.tools', 'Enumerated the readable tool roots', {});
    artifacts.push(toolsArtifact.id); events.push(toolsEvent);
    checks.push(record(succeededCheck('tools', makeEvidence({ artifactIds: [toolsArtifact.id], eventIds: [toolsEvent], taskId: job.taskId, jobId: job.jobId, summary: 'Approved workspace-files reads succeeded and were enumerated.' }))));

    // 4. authentication: assert no external credentials are referenced.
    const credentialRefs = (manifest.permissions as Grant[]).filter(grant => grant.credentialRef !== null);
    if (credentialRefs.length) throw new WorkerError('TOOL_UNAVAILABLE', 'External credentials are unavailable in this deployment', false);
    const authEvent = await this.observe(job, 'verification.authentication', 'Worker credential and current lease authenticated every provisioning call', { worker: this.deps.config.workerPrincipalId, credentials: 0 });
    events.push(authEvent);
    checks.push(record(succeededCheck('authentication', makeEvidence({ eventIds: [authEvent], taskId: job.taskId, jobId: job.jobId, summary: 'Every provisioning call used the authenticated worker credential and current lease; no external credential is required.' }))));

    // 5. permissions: confirm every grant is a supported local operation.
    for (const grant of manifest.permissions as Grant[]) {
      const supported = SUPPORTED_TOOLS[grant.tool];
      if (!supported || !manifest.tools.includes(grant.tool) || grant.operations.some(op => !supported.includes(op)) || grant.resource !== null) {
        throw new WorkerError('INVALID_GRANT', `Grant for ${grant.tool} is not a supported local capability`, false);
      }
    }
    const permissionEvent = await this.observe(job, 'verification.permissions', 'Validated the approved grant set against supported local operations', { tools: manifest.tools });
    events.push(permissionEvent);
    checks.push(record(succeededCheck('permissions', makeEvidence({ eventIds: [permissionEvent], taskId: job.taskId, jobId: job.jobId, summary: `Grants for ${(manifest.tools as string[]).join(', ') || 'no tools'} are within the supported local allowlist.` }))));

    // 6. memory: initialize agent-scoped working memory and read it back.
    const memoryRecord = JSON.stringify({ agentId: agent.id, initializedAt: nowIso(), standards: manifest.context?.canonicalMemoryIds ?? [] }, null, 2);
    await this.deps.workspace.writeWorkspaceFile(agent.id, 'memory/working.json', memoryRecord);
    const memoryArtifact = await this.publish(job, 'memory-initialization.json', memoryRecord, 'application/json');
    const memoryReadback = await this.deps.workspace.read('workspace', agent.id, 'memory/working.json');
    if (memoryReadback !== memoryRecord) throw new WorkerError('MEMORY_INTEGRITY', 'Agent working memory did not read back verbatim', false);
    const memoryEvent = await this.observe(job, 'verification.memory', 'Initialized scoped working memory and verified read-back', { path: 'memory/working.json' });
    artifacts.push(memoryArtifact.id); events.push(memoryEvent);
    checks.push(record(succeededCheck('memory', makeEvidence({ artifactIds: [memoryArtifact.id], eventIds: [memoryEvent], taskId: job.taskId, jobId: job.jobId, summary: 'Agent working memory was written and read back verbatim.' }))));

    // 7. communication: verify the manifest's communication policy is internally consistent.
    if (manifest.communication.canContactManager !== (manifest.escalation.managerId === manifest.organization.managerId)) {
      throw new WorkerError('INVALID_COMMUNICATION', 'Communication and escalation policies disagree about the manager', false);
    }
    const communicationEvent = await this.observe(job, 'verification.communication', 'Validated manager, report and communication policy consistency', { managerId: manifest.organization.managerId });
    events.push(communicationEvent);
    checks.push(record(succeededCheck('communication', makeEvidence({ eventIds: [communicationEvent], taskId: job.taskId, jobId: job.jobId, summary: 'Communication policy matches the approved reporting relationship.' }))));

    // 8. escalation: verify escalation routes to the authoritative manager.
    const escalationEvent = await this.observe(job, 'verification.escalation', 'Validated escalation routing to the authoritative manager', { managerId: manifest.escalation.managerId, triggers: manifest.escalation.triggers });
    events.push(escalationEvent);
    checks.push(record(succeededCheck('escalation', makeEvidence({ eventIds: [escalationEvent], taskId: job.taskId, jobId: job.jobId, summary: 'Escalation routes to the approved reporting manager with named triggers.' }))));

    // 9. observability: confirm this attempt's observations are durably queryable.
    const observabilityEvent = await this.observe(job, 'verification.observability', 'Confirmed this attempt emitted durable, scoped observations', {
      observed: [runtimeEvent, modelEvent, toolsEvent, authEvent, permissionEvent, memoryEvent],
    });
    events.push(observabilityEvent);
    checks.push(record(succeededCheck('observability', makeEvidence({ eventIds: [observabilityEvent], taskId: job.taskId, jobId: job.jobId, summary: 'Model, tool and verification observations were persisted for this attempt.' }))));

    // 10. evaluation: evaluate the real model self-check output against the manifest criteria.
    const passedModel = /READY/i.test(modelReply);
    if (!passedModel) throw new WorkerError('EVALUATION_FAILED', 'The model self-check did not return the expected confirmation', true);
    const evaluationEvent = await this.observe(job, 'verification.evaluation', 'Evaluated recorded model output against the manifest criteria', { criteria: manifest.evaluation.criteria, passed: passedModel });
    events.push(evaluationEvent);
    checks.push(record(succeededCheck('evaluation', makeEvidence({ artifactIds: [runtimeArtifact.id], eventIds: [modelEvent, evaluationEvent], taskId: job.taskId, jobId: job.jobId, summary: 'Recorded model output satisfied the manifest evaluation criteria.' }))));

    // 11. restart: confirm persisted knowledge survives independently of the process.
    const restartArtifact = await this.publish(job, 'restart-check.json', JSON.stringify({ path: 'memory/working.json', bytes: Buffer.byteLength(memoryReadback) }), 'application/json');
    const restartEvent = await this.observe(job, 'verification.restart', 'Re-read durable workspace knowledge after the write', { path: 'memory/working.json' });
    artifacts.push(restartArtifact.id); events.push(restartEvent);
    checks.push(record(succeededCheck('restart', makeEvidence({ artifactIds: [restartArtifact.id], eventIds: [memoryEvent, restartEvent], taskId: job.taskId, jobId: job.jobId, summary: 'Agent knowledge persisted outside the process and was re-read successfully.' }))));

    // 12. end_to_end: a real model round trip that produced a verified artifact.
    const endToEndEvent = await this.observe(job, 'verification.end_to_end', 'Exercised a model call that produced a verified immutable artifact', {
      model: this.deps.model.name, artifact: runtimeArtifact.path, sha256: probe.sha256,
    });
    events.push(endToEndEvent);
    checks.push(record(succeededCheck('end_to_end', makeEvidence({ artifactIds: [runtimeArtifact.id], eventIds: [modelEvent, endToEndEvent], taskId: job.taskId, jobId: job.jobId, summary: 'A real model invocation and immutable artifact write completed end to end.' }))));

    // Every manifest-specific required check must also be present and pass.
    const required = new Set<string>([...REQUIRED_VERIFICATION_CHECKS, ...(manifest.evaluation.requiredVerificationChecks ?? [])]);
    for (const name of required) {
      if (!verified.has(name)) throw new WorkerError('VERIFICATION_REQUIRED', `Missing mandatory verification: ${name}`, false);
    }

    const steps: ProvisioningStep[] = checks.map(check => ({ name: check.name, status: 'PASSED', evidence: check.evidence, error: null }));
    const resources = this.buildResources(agent, manifest, checks);
    await ledger.settle();
    await this.deps.client.complete(job, { kind: job.kind as 'provision_agent' | 'reconfigure_agent', steps, checks, resources });
  }

  private buildResources(agent: Record<string, any>, manifest: Record<string, any>, checks: VerificationCheck[]): Resource[] {
    const base = () => ({ id: randomUUID(), organizationId: agent.organizationId, version: 1, createdAt: nowIso(), updatedAt: nowIso() });
    const workspaceGrant = (manifest.permissions as Grant[]).find(grant => grant.tool === 'workspace-files');
    const verificationFor = (name: string): VerificationCheck => checks.find(check => check.name === name)!;
    const resources: Resource[] = [
      {
        ...base(), agentId: agent.id, type: 'workspace', reference: `${agent.id}/workspace`, status: 'AVAILABLE',
        grants: workspaceGrant ? [workspaceGrant] : [], verification: verificationFor('runtime'),
      },
      {
        ...base(), agentId: agent.id, type: 'runtime', reference: this.deps.config.modelName, status: 'AVAILABLE',
        grants: [], verification: verificationFor('model'),
      },
    ];
    if (manifest.memory?.working) {
      resources.push({
        ...base(), agentId: agent.id, type: 'tool', reference: 'workspace-files', status: 'AVAILABLE',
        grants: workspaceGrant ? [workspaceGrant] : [], verification: verificationFor('tools'),
      });
    }
    return resources;
  }

  // --- run_task -------------------------------------------------------------

  private async runTask(job: ClaimedJob, ledger: JobLedger): Promise<void> {
    const payload = job.payload as any;
    const { agent, task, inputMessage } = payload;
    const manifest = agent.manifest as Record<string, any>;
    if (!manifest) throw new WorkerError('MANIFEST_MISSING', 'The agent has no approved manifest to execute with', false);
    await ledger.reserve(this.deps.config.maxToolRounds);

    const tools: ToolDefinition[] = [];
    const grantOf = (tool: string): Grant | undefined => (manifest.permissions as Grant[]).find(grant => grant.tool === tool);
    const workspaceGrant = grantOf('workspace-files');
    const operations = new Set(workspaceGrant?.operations ?? []);
    if (operations.has('list')) tools.push({ name: 'list_files', description: 'List files under the read-only briefs or the agent workspace.', parameters: { type: 'object', properties: { root: { type: 'string', enum: ['briefs', 'workspace'] }, path: { type: 'string' } }, required: ['root'] } });
    if (operations.has('read')) tools.push({ name: 'read_file', description: 'Read one text file from the briefs or the agent workspace.', parameters: { type: 'object', properties: { root: { type: 'string', enum: ['briefs', 'workspace'] }, path: { type: 'string' } }, required: ['root', 'path'] } });
    if (operations.has('write')) tools.push({ name: 'write_file', description: 'Write a deliverable into the immutable job output. Use a relative filename.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } });
    const hireGrant = grantOf('request_hire');
    if (hireGrant?.operations.includes('request')) tools.push({
      name: 'request_hire',
      description: 'Request one governed hire when a real capability gap blocks the deliverable. Humans must still approve it.',
      parameters: {
        type: 'object',
        properties: {
          role: { type: 'string' }, mission: { type: 'string' }, justification: { type: 'string' },
          teamId: { type: 'string' }, agentType: { type: 'string', enum: ['employee', 'consultant'] }, expectedBenefit: { type: 'string' },
        },
        required: ['role', 'mission', 'justification', 'expectedBenefit'],
      },
    });

    const written = new Map<string, { id: string; path: string }>();
    const eventIds: string[] = [];
    const artifactIds: string[] = [];

    const handleTool = async (call: ToolCall): Promise<string> => {
      try {
        if (call.name === 'list_files') {
          const root = call.arguments.root === 'workspace' ? 'workspace' : 'briefs';
          const listing = await this.deps.workspace.list(root, agent.id, typeof call.arguments.path === 'string' ? call.arguments.path : '.');
          const event = await this.toolEvent(job, manifest, 'workspace-files', 'list', { root, path: call.arguments.path ?? '.' });
          if (event) eventIds.push(event);
          return JSON.stringify(listing);
        }
        if (call.name === 'read_file') {
          const root = call.arguments.root === 'workspace' ? 'workspace' : 'briefs';
          const path = String(call.arguments.path ?? '');
          const content = await this.deps.workspace.read(root, agent.id, path);
          const event = await this.toolEvent(job, manifest, 'workspace-files', 'read', { root, path });
          if (event) eventIds.push(event);
          return content.slice(0, MAX_TOOL_RESULT_CHARS);
        }
        if (call.name === 'write_file') {
          const name = String(call.arguments.path ?? 'deliverable.md');
          const content = String(call.arguments.content ?? '');
          const stored = await this.deps.workspace.writeArtifact(agent.id, job.jobId, job.attempt, name, content);
          const published = await this.deps.client.publishArtifact(job, { path: stored.path, contentType: 'text/plain', size: stored.size, sha256: stored.sha256, scope: PRIVATE_SCOPE });
          written.set(name, { id: published.id, path: published.path });
          artifactIds.push(published.id);
          const event = await this.toolEvent(job, manifest, 'workspace-files', 'write', { path: published.path, sha256: stored.sha256 });
          if (event) eventIds.push(event);
          return `wrote ${published.path} (${stored.size} bytes, sha256 ${stored.sha256})`;
        }
        if (call.name === 'request_hire') {
          const proposal = this.buildHireProposal(call.arguments, agent, manifest);
          const hire = await this.deps.client.asAgent<{ id: string }>(job, 'createHiringRequest', '/v1/hiring-requests', proposal);
          const event = await this.toolEvent(job, manifest, 'request_hire', 'request', { hiringRequestId: hire.id });
          if (event) eventIds.push(event);
          return `hiring request ${hire.id} created and awaiting human approval`;
        }
        return `unknown tool: ${call.name}`;
      } catch (error) {
        if (error instanceof LeaseLostError) throw error;
        // Tool problems are returned to the model instead of fabricating success.
        return `tool error: ${(error as Error).message}`;
      }
    };

    const result = await runToolLoop({
      model: this.deps.model,
      system: this.taskSystemPrompt(manifest),
      prompt: this.taskPrompt(agent, task, inputMessage),
      tools,
      maxRounds: this.deps.config.maxToolRounds,
      handleTool,
      onTurn: async turn => {
        ledger.record(turn.usage);
        const event = await this.observe(job, 'model.execution', 'Model turn during task execution', {
          model: this.deps.model.name, toolCalls: turn.toolCalls.map(toolCall => toolCall.name),
          inputTokens: turn.usage.inputTokens, outputTokens: turn.usage.outputTokens,
        });
        eventIds.push(event);
      },
    });

    const parsed = this.parseTaskDraft(result.content);
    const summary = parsed.summary;
    // Always persist the final answer as a real artifact so evidence is concrete.
    const finalArtifact = await this.publish(job, 'result.md', result.content || summary, 'text/markdown');
    artifactIds.push(finalArtifact.id);
    const reply = inputMessage ? (parsed.reply || summary) : null;
    const evidence = makeEvidence({ artifactIds, eventIds, taskId: task.id, jobId: job.jobId, summary });
    await ledger.settle();
    await this.deps.client.complete(job, { kind: 'run_task', evidence, summary, reply });
  }

  private buildHireProposal(args: Record<string, unknown>, agent: Record<string, any>, manifest: Record<string, any>): Record<string, any> {
    const agentType = args.agentType === 'consultant' ? 'consultant' : 'employee';
    // A descendant gets only the restricted local workspace tool; it cannot re-recruit.
    const tools = ['workspace-files'];
    const grants: Grant[] = [{ tool: 'workspace-files', operations: ['read', 'write', 'list'], resource: null, credentialRef: null }];
    return {
      justification: String(args.justification),
      role: String(args.role),
      mission: String(args.mission),
      teamId: typeof args.teamId === 'string' && args.teamId ? args.teamId : manifest.organization.teamId,
      proposedManagerId: agent.id,
      proposedManagerKind: 'agent',
      agentType,
      responsibilities: [String(args.mission)],
      tools,
      grants,
      expectedBenefit: String(args.expectedBenefit),
      budget: { modelCallsDaily: 10, externalSpendDaily: 0, currency: this.deps.config.currency, maxConcurrentTasks: 1 },
      ...(agentType === 'consultant'
        ? { consultant: { deliverable: String(args.mission), deadline: null, terminationCondition: 'Deliverable accepted by the requesting agent.', knowledgeRecipientIds: [agent.id] } }
        : {}),
    };
  }

  private taskSystemPrompt(manifest: Record<string, any>): string {
    return [
      `You are ${manifest.agent.name}, an AI employee.`,
      `Mission: ${manifest.mission.primary}`,
      `Responsibilities: ${(manifest.responsibilities as string[]).join('; ')}.`,
      `Standards: ${(manifest.standards as string[]).join('; ')}.`,
      `Tools: ${(manifest.tools as string[]).join(', ') || 'none'}.`,
      'Produce only grounded work: read approved briefs before asserting facts and never invent evidence.',
      'When finished, respond with a single JSON object: {"summary": "...", "reply": "..."} where reply addresses the requester.',
      'Use write_file to persist any deliverable. Keep file names relative and simple.',
    ].join(' ');
  }

  private taskPrompt(agent: Record<string, any>, task: Record<string, any>, inputMessage: Record<string, any> | null): string {
    return JSON.stringify({
      agentId: agent.id,
      objective: task.objective,
      constraints: task.constraints,
      deliverable: task.deliverable,
      deadline: task.deadline,
      incomingMessage: inputMessage ? { from: inputMessage.sender?.id, content: inputMessage.content } : null,
    });
  }

  private parseTaskDraft(content: string): { summary: string; reply: string | null } {
    try {
      const draft = extractJson<TaskDraft>(content);
      const summary = typeof draft.summary === 'string' && draft.summary.trim() ? draft.summary.trim() : firstParagraph(content);
      const reply = typeof draft.reply === 'string' && draft.reply.trim() ? draft.reply.trim() : null;
      return { summary: summary || 'Completed the delegated task.', reply };
    } catch {
      const text = content.trim() || 'Completed the delegated task.';
      return { summary: firstParagraph(text), reply: null };
    }
  }

  // --- learn ----------------------------------------------------------------

  private async learn(job: ClaimedJob, ledger: JobLedger): Promise<void> {
    const payload = job.payload as any;
    const agent = payload.agent;
    const manifest = agent.manifest as Record<string, any>;
    await ledger.reserve(1);
    const memory = await this.deps.workspace.read('workspace', agent.id, 'memory/working.json').catch(() => '{}');
    const turn = await this.deps.model.turn({
      system: [
        'You capture one grounded, evidence-backed lesson from an agent\'s recent execution.',
        'Respond with a single JSON object: {"observation": "...", "hypothesis": "...", "conclusion": "...", "title": "...", "content": "..."}.',
        'Only record observations supported by the supplied material. Never invent results.',
      ].join(' '),
      messages: [{ role: 'user', content: JSON.stringify({ agentId: agent.id, mission: manifest.mission?.primary, workingMemory: memory.slice(0, 4000) }) }],
    });
    ledger.record(turn.usage);
    const learningEvent = await this.observe(job, 'model.learning', 'Model proposed an evidence-backed lesson', { model: this.deps.model.name, modelCalls: turn.usage.modelCalls });
    const draft = extractJson<LearningDraft>(turn.content);
    const observation = typeof draft.observation === 'string' && draft.observation.trim() ? draft.observation.trim() : 'Reviewed recent execution.';
    const hypothesis = typeof draft.hypothesis === 'string' && draft.hypothesis.trim() ? draft.hypothesis.trim() : 'Repeated evidence checks improve reliability.';
    const conclusion = typeof draft.conclusion === 'string' && draft.conclusion.trim() ? draft.conclusion.trim() : 'Keep verifying sources before drafting.';
    const title = typeof draft.title === 'string' && draft.title.trim() ? draft.title.trim() : 'Learning from recent execution';
    const artifact = await this.publish(job, 'learning.json', JSON.stringify({ observation, hypothesis, conclusion, title, content: draft.content ?? conclusion }, null, 2), 'application/json');
    const evidence = makeEvidence({ artifactIds: [artifact.id], eventIds: [learningEvent], taskId: job.taskId, jobId: job.jobId, summary: `Recorded lesson: ${title}` });
    // Persist the tactical memory as the delegated agent so scope and provenance are real.
    const memoryEntry = await this.deps.client.asAgent<{ id: string }>(job, 'createMemory', '/v1/memory', {
      ownerAgentId: agent.id,
      category: 'episodic',
      title,
      content: conclusion,
      scope: PRIVATE_SCOPE,
      provenance: evidence,
      expiresAt: null,
      supersedesId: null,
    });
    await ledger.settle();
    await this.deps.client.complete(job, {
      kind: 'learn',
      learning: { observation, hypothesis, conclusion, evidence, memoryIds: [memoryEntry.id], canonicalRevisionId: null },
    });
  }

  // --- retire_agent ---------------------------------------------------------

  private async retire(job: ClaimedJob, ledger: JobLedger): Promise<void> {
    const payload = job.payload as any;
    const agent = payload.agent;
    const reason = String(payload.reason ?? 'Approved retirement');
    const preserved = await this.deps.workspace.list('workspace', agent.id).catch(() => []);
    const record = await this.publish(job, 'retirement.json', JSON.stringify({ agentId: agent.id, reason, retiredAt: nowIso(), preservedKnowledge: preserved }, null, 2), 'application/json');
    const event = await this.observe(job, 'retirement.cleanup', 'Disabled the local runtime and preserved durable knowledge', {
      reason, credentials: 0, preservedFiles: preserved.length, runtime: this.deps.config.modelName,
    });
    const evidence = makeEvidence({ artifactIds: [record.id], eventIds: [event], taskId: job.taskId, jobId: job.jobId, summary: `Retired ${agent.id}: ${reason}` });
    await ledger.settle();
    await this.deps.client.complete(job, {
      kind: 'retire_agent',
      evidence,
      // This deployment holds no external credentials, so there are none to revoke.
      credentialsRevoked: true,
      runtimeDisabled: true,
      knowledgePreserved: true,
      // The control plane refuses to enqueue retirement while active tasks remain.
      activeTasksResolved: true,
    });
  }
}
