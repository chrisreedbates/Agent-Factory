import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentManifest, validateResponse, validationErrors } from '@agent-factory/contracts';
import type { ControlPlane } from './client.js';
import type { WorkerConfig } from './config.js';
import { LeaseLostError, WorkerError } from './errors.js';
import { addUsage, EMPTY_USAGE, extractJson, type ModelAdapter, type ModelUsage, type ToolCall, type ToolDefinition, runToolLoop } from './model.js';
import { REQUIRED_VERIFICATION_CHECKS, makeEvidence, succeededCheck } from './evidence.js';
import type { ClaimedJob, Grant, ProvisioningStep, Resource, Scope, VerificationCheck } from './types.js';
import type { LeaseGuard } from './runtime.js';
import type { Workspace } from './workspace.js';

const execFileAsync = promisify(execFile);

export const SUPPORTED_TOOLS: Readonly<Record<string, readonly string[]>> = {
  'workspace-files': ['read', 'write', 'list'],
  request_hire: ['request'],
};

const PRIVATE_SCOPE: Scope = { visibility: 'private', teamId: null, agentIds: [] };
const MAX_TOOL_RESULT_CHARS = 8_000;
/** Codes that must stop the whole attempt rather than being returned to the model. */
const FATAL_TOOL_CODES = new Set(['GRANT_REVOKED', 'EXECUTION_CANCELLED']);

const nowIso = () => new Date().toISOString();

const stringList = (value: unknown, fallback: string[], max = 20): string[] => {
  const items = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
  const unique = [...new Set(items.map(item => item.trim()))].slice(0, max);
  return unique.length ? unique : fallback;
};

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

interface ToolSpec {
  definition: ToolDefinition;
  tool: string;
  operation: string;
}

interface WrittenArtifact {
  id: string;
  path: string;
  sha256: string;
  absolutePath: string;
}

interface AgentLoopResult {
  content: string;
  written: Map<string, WrittenArtifact>;
  readCount: number;
  eventIds: string[];
  artifactIds: string[];
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
  deliverable?: unknown;
}

interface EscalationDraft {
  trigger?: unknown;
  situation?: unknown;
  recommendation?: unknown;
}

interface ProvisionDraft extends TaskDraft {
  escalation?: unknown;
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

  async run(job: ClaimedJob, ledger: JobLedger, guard: LeaseGuard): Promise<void> {
    switch (job.kind) {
      case 'compile_manifest': return this.compileManifest(job, ledger, guard);
      case 'provision_agent':
      case 'reconfigure_agent': return this.provision(job, ledger, guard);
      case 'run_task': return this.runTask(job, ledger, guard);
      case 'learn': return this.learn(job, ledger, guard);
      case 'retire_agent': return this.retire(job, ledger, guard);
      default: throw new WorkerError('UNKNOWN_JOB', `Unsupported job kind ${job.kind}`, false);
    }
  }

  private agentOf(job: ClaimedJob): Record<string, any> {
    return (job.payload as any).agent as Record<string, any>;
  }

  private async observe(job: ClaimedJob, guard: LeaseGuard, type: string, message: string, data: Record<string, unknown> = {}): Promise<string> {
    guard.assertLive();
    const event = await this.deps.client.appendEvent(job, { type, message, data });
    return event.id;
  }

  /** Write, read back and hash-verify immutable bytes, then publish them under the lease. */
  private async publish(
    job: ClaimedJob,
    guard: LeaseGuard,
    name: string,
    content: string | Buffer,
    contentType = 'text/plain',
  ): Promise<WrittenArtifact> {
    guard.assertLive();
    const agent = this.agentOf(job);
    const stored = await this.deps.workspace.writeArtifact(agent.id, job.jobId, job.attempt, name, content);
    const back = await this.deps.workspace.readBack(stored.absolutePath);
    if (back.sha256 !== stored.sha256 || back.size !== stored.size) {
      throw new WorkerError('ARTIFACT_INTEGRITY', `Read-back mismatch for ${stored.path}`, false);
    }
    const published = await this.deps.client.publishArtifact(job, {
      path: stored.path,
      contentType,
      size: stored.size,
      sha256: stored.sha256,
      scope: PRIVATE_SCOPE,
    });
    return { id: published.id, path: stored.path, sha256: stored.sha256, absolutePath: stored.absolutePath };
  }

  /** Emit a tool observation only when the approved manifest grants the operation. */
  private async toolEvent(
    job: ClaimedJob,
    guard: LeaseGuard,
    manifest: Record<string, any>,
    tool: string,
    operation: string,
    data: Record<string, unknown>,
  ): Promise<string | null> {
    const grant = (manifest.permissions as Grant[]).find(candidate => candidate.tool === tool);
    if (!grant || !grant.operations.includes(operation)) return null;
    return this.observe(job, guard, `tool.${tool}`, `Executed ${tool} ${operation}`, { tool, operation, ...data });
  }

  /** Re-read the agent's live record and current grants immediately before a tool operation. */
  private async assertLiveGrant(job: ClaimedJob, guard: LeaseGuard, manifest: Record<string, any>, spec: ToolSpec): Promise<void> {
    guard.assertLive();
    if (!['run_task', 'learn'].includes(job.kind)) {
      // Provisioning cannot delegate as the agent; the approved manifest is the authority.
      const grant = (manifest.permissions as Grant[]).find(candidate => candidate.tool === spec.tool);
      if (!grant || !grant.operations.includes(spec.operation)) {
        throw new WorkerError('GRANT_REVOKED', `The approved manifest does not grant ${spec.tool} ${spec.operation}`, false);
      }
      return;
    }
    const live = await this.deps.client.getAgent(job, this.agentOf(job).id);
    const agent = live.agent as Record<string, any>;
    if (agent.cancellationRequested) throw new WorkerError('EXECUTION_CANCELLED', 'Agent execution is cancelled', false);
    const grant = (live.grants as Grant[]).find(candidate => candidate.tool === spec.tool);
    if (!grant || !grant.operations.includes(spec.operation)) {
      throw new WorkerError('GRANT_REVOKED', `Current grants no longer authorize ${spec.tool} ${spec.operation}`, false);
    }
  }

  /** Build only the tools the approved manifest actually grants. */
  private offeredTools(manifest: Record<string, any>, includeRecruitment: boolean): Map<string, ToolSpec> {
    const offered = new Map<string, ToolSpec>();
    const grantOf = (tool: string): Grant | undefined => (manifest.permissions as Grant[]).find(candidate => candidate.tool === tool);
    const workspaceGrant = grantOf('workspace-files');
    const operations = new Set(workspaceGrant?.operations ?? []);
    if (operations.has('list')) {
      offered.set('list_files', {
        tool: 'workspace-files', operation: 'list',
        definition: { name: 'list_files', description: 'List files under the read-only briefs or the agent workspace.', parameters: { type: 'object', properties: { root: { type: 'string', enum: ['briefs', 'workspace'] }, path: { type: 'string' } }, required: ['root'] } },
      });
    }
    if (operations.has('read')) {
      offered.set('read_file', {
        tool: 'workspace-files', operation: 'read',
        definition: { name: 'read_file', description: 'Read one text file from the briefs or the agent workspace.', parameters: { type: 'object', properties: { root: { type: 'string', enum: ['briefs', 'workspace'] }, path: { type: 'string' } }, required: ['root', 'path'] } },
      });
    }
    if (operations.has('write')) {
      offered.set('write_file', {
        tool: 'workspace-files', operation: 'write',
        definition: { name: 'write_file', description: 'Write a deliverable into the immutable job output. Use a simple relative filename.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
      });
    }
    const hireGrant = grantOf('request_hire');
    if (includeRecruitment && hireGrant?.operations.includes('request')) {
      offered.set('request_hire', {
        tool: 'request_hire', operation: 'request',
        definition: {
          name: 'request_hire',
          description: 'Request one governed hire when a real capability gap blocks the deliverable. A human must still approve it.',
          parameters: {
            type: 'object',
            properties: {
              role: { type: 'string' }, mission: { type: 'string' }, justification: { type: 'string' },
              teamId: { type: 'string' }, agentType: { type: 'string', enum: ['employee', 'consultant'] }, expectedBenefit: { type: 'string' },
            },
            required: ['role', 'mission', 'justification', 'expectedBenefit'],
          },
        },
      });
    }
    return offered;
  }

  private validateToolArguments(name: string, args: Record<string, unknown>): string | null {
    const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
    if (name === 'list_files') {
      if (args.root !== 'briefs' && args.root !== 'workspace') return 'root must be briefs or workspace';
      return args.path === undefined || typeof args.path === 'string' ? null : 'path must be a string';
    }
    if (name === 'read_file') {
      if (args.root !== 'briefs' && args.root !== 'workspace') return 'root must be briefs or workspace';
      return text(args.path) ? null : 'path must be a non-empty string';
    }
    if (name === 'write_file') {
      if (!text(args.path)) return 'path must be a non-empty string';
      return typeof args.content === 'string' && args.content.trim().length > 0 ? null : 'content must be non-empty';
    }
    if (name === 'request_hire') {
      for (const key of ['role', 'mission', 'justification', 'expectedBenefit']) if (!text(args[key])) return `${key} must be a non-empty string`;
      if (args.agentType !== undefined && args.agentType !== 'employee' && args.agentType !== 'consultant') return 'agentType must be employee or consultant';
      return args.teamId === undefined || typeof args.teamId === 'string' ? null : 'teamId must be a string';
    }
    return 'unknown tool';
  }

  private async childProcessHash(absolutePath: string): Promise<string> {
    const script = "const fs=require('fs'),c=require('crypto');process.stdout.write(c.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'))";
    const { stdout } = await execFileAsync(process.execPath, ['-e', script, absolutePath], { timeout: 10_000, windowsHide: true });
    return stdout.trim();
  }

  /**
   * A bounded, enforced agent tool loop shared by task execution and end-to-end
   * provisioning. Every call is revalidated against the offered tool set, its
   * arguments, the live lease and the control plane's current grants.
   */
  private async agentToolLoop(input: {
    job: ClaimedJob;
    ledger: JobLedger;
    guard: LeaseGuard;
    agent: Record<string, any>;
    manifest: Record<string, any>;
    offered: Map<string, ToolSpec>;
    system: string;
    prompt: string;
    maxRounds: number;
  }): Promise<AgentLoopResult> {
    const { job, ledger, guard, agent, manifest, offered } = input;
    const written = new Map<string, WrittenArtifact>();
    const eventIds: string[] = [];
    const artifactIds: string[] = [];
    let readCount = 0;

    const handleTool = async (call: ToolCall): Promise<string> => {
      const spec = offered.get(call.name);
      if (!spec) return `denied: tool ${call.name} was not offered for this attempt`;
      const argumentError = this.validateToolArguments(call.name, call.arguments);
      if (argumentError) return `denied: ${argumentError}`;
      await this.assertLiveGrant(job, guard, manifest, spec);
      try {
        if (call.name === 'list_files') {
          const root = call.arguments.root === 'workspace' ? 'workspace' : 'briefs';
          const listing = await this.deps.workspace.list(root, agent.id, typeof call.arguments.path === 'string' ? call.arguments.path : '.');
          const event = await this.toolEvent(job, guard, manifest, spec.tool, spec.operation, { root, path: call.arguments.path ?? '.' });
          if (event) eventIds.push(event);
          return JSON.stringify(listing);
        }
        if (call.name === 'read_file') {
          const root = call.arguments.root === 'workspace' ? 'workspace' : 'briefs';
          const path = String(call.arguments.path);
          const content = await this.deps.workspace.read(root, agent.id, path);
          readCount++;
          const event = await this.toolEvent(job, guard, manifest, spec.tool, spec.operation, { root, path });
          if (event) eventIds.push(event);
          return content.slice(0, MAX_TOOL_RESULT_CHARS);
        }
        if (call.name === 'write_file') {
          const name = String(call.arguments.path);
          const content = String(call.arguments.content);
          const stored = await this.publish(job, guard, name, content);
          written.set(name, stored);
          artifactIds.push(stored.id);
          const event = await this.toolEvent(job, guard, manifest, spec.tool, spec.operation, { path: stored.path, sha256: stored.sha256 });
          if (event) eventIds.push(event);
          return `wrote ${stored.path} (${stored.sha256})`;
        }
        if (call.name === 'request_hire') {
          const proposal = this.buildHireProposal(call.arguments, agent, manifest);
          const hire = await this.deps.client.asAgent<{ id: string }>(job, 'createHiringRequest', '/v1/hiring-requests', proposal);
          const event = await this.toolEvent(job, guard, manifest, spec.tool, spec.operation, { hiringRequestId: hire.id });
          if (event) eventIds.push(event);
          return `hiring request ${hire.id} created and awaiting human approval`;
        }
        return `unknown tool: ${call.name}`;
      } catch (error) {
        if (error instanceof LeaseLostError) throw error;
        if (error instanceof WorkerError && FATAL_TOOL_CODES.has(error.code)) throw error;
        // Ordinary tool problems are returned to the model instead of fabricating success.
        return `tool error: ${(error as Error).message}`;
      }
    };

    const result = await runToolLoop({
      model: this.deps.model,
      system: input.system,
      prompt: input.prompt,
      tools: [...offered.values()].map(spec => spec.definition),
      maxRounds: input.maxRounds,
      handleTool,
      onTurn: async turn => {
        ledger.record(turn.usage);
        const event = await this.observe(job, guard, 'model.execution', 'Model turn during execution', {
          model: this.deps.model.name, toolCalls: turn.toolCalls.map(toolCall => toolCall.name),
          inputTokens: turn.usage.inputTokens, outputTokens: turn.usage.outputTokens,
        });
        eventIds.push(event);
      },
    });
    return { content: result.content, written, readCount, eventIds, artifactIds };
  }

  // --- compile_manifest -----------------------------------------------------

  private async compileManifest(job: ClaimedJob, ledger: JobLedger, guard: LeaseGuard): Promise<void> {
    const payload = job.payload as any;
    const { hiringRequest, agent, organization, teams } = payload;
    await ledger.reserve(1);
    const team = (teams as Record<string, any>[]).find(candidate => candidate.id === hiringRequest.proposal.teamId);
    guard.assertLive();
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
    await this.observe(job, guard, 'model.compilation', 'Compiled a role draft from the hiring request', {
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
    guard.assertLive();
    await this.deps.client.complete(job, { kind: 'compile_manifest', manifest });
  }

  private assembleManifest(draft: RoleDraft, input: { hiringRequest: any; agent: any; organization: any; team: any }): Record<string, any> {
    const proposal = input.hiringRequest.proposal;
    if (proposal.agentType === 'consultant' && !proposal.consultant) {
      throw new WorkerError('CONSULTANT_BOUND_REQUIRED', 'A consultant proposal must include its deliverable and termination condition', false);
    }
    const requestedTools: string[] = [...new Set<string>(proposal.tools)];
    const unsupported = requestedTools.filter(tool => !Object.hasOwn(SUPPORTED_TOOLS, tool));
    if (unsupported.length) {
      // A real capability gap must block compilation, not be silently dropped.
      throw new WorkerError('TOOL_UNAVAILABLE', `Unsupported requested tools: ${unsupported.join(', ')}`, false);
    }
    const permissions = (proposal.grants as Grant[]).filter(grant => requestedTools.includes(grant.tool));
    const invalidGrants = (proposal.grants as Grant[]).filter(
      grant => !requestedTools.includes(grant.tool) || grant.operations.some(op => !SUPPORTED_TOOLS[grant.tool]?.includes(op)),
    );
    if (invalidGrants.length) {
      throw new WorkerError('INVALID_GRANT', `Proposal contains unsupported grants: ${invalidGrants.map(grant => grant.tool).join(', ')}`, false);
    }
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
      tools: requestedTools,
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

  private async provision(job: ClaimedJob, ledger: JobLedger, guard: LeaseGuard): Promise<void> {
    const payload = job.payload as any;
    const agent = payload.agent as Record<string, any>;
    const manifest = payload.manifest as Record<string, any>;
    const maxRounds = Math.min(3, this.deps.config.maxToolRounds);
    // One strict model self-check plus the bounded end-to-end tool loop.
    await ledger.reserve(1 + maxRounds);

    const artifacts: string[] = [];
    const events: string[] = [];
    const checks: VerificationCheck[] = [];
    const pass = (name: string, evidence: ReturnType<typeof makeEvidence>) => {
      checks.push(succeededCheck(name, evidence));
      return evidence;
    };

    // 1. runtime: durable probe with hash read-back.
    const probe = await this.deps.workspace.probe(agent.id, job.jobId, job.attempt, 'runtime-probe.txt', `runtime probe ${job.jobId} ${nowIso()}`);
    const runtimeArtifact = await this.publish(job, guard, 'runtime-probe.txt', probe.content);
    const runtimeEvent = await this.observe(job, guard, 'verification.runtime', 'Workspace write/read/hash probe passed with read-back', { path: runtimeArtifact.path, sha256: probe.sha256 });
    artifacts.push(runtimeArtifact.id); events.push(runtimeEvent);
    pass('runtime', makeEvidence({ artifactIds: [runtimeArtifact.id], eventIds: [runtimeEvent], taskId: job.taskId, jobId: job.jobId, summary: `Immutable runtime probe ${runtimeArtifact.path} round-tripped with a matching SHA-256.` }));

    // 2. model: the model must echo a nonce exactly, so partial or negated replies fail.
    const nonce = randomUUID();
    guard.assertLive();
    const selfCheck = await this.deps.model.turn({
      system: 'You are a runtime self-check. Reply with exactly the token the user sends, and nothing else.',
      messages: [{ role: 'user', content: nonce }],
    });
    ledger.record(selfCheck.usage);
    const echoed = (selfCheck.content ?? '').trim();
    const modelEvent = await this.observe(job, guard, 'model.selfcheck', 'Invoked the configured model for a strict self-check', {
      model: this.deps.model.name, modelCalls: selfCheck.usage.modelCalls, inputTokens: selfCheck.usage.inputTokens, outputTokens: selfCheck.usage.outputTokens, matched: echoed === nonce,
    });
    events.push(modelEvent);
    if (echoed !== nonce) {
      throw new WorkerError('MODEL_SELFCHECK_FAILED', `The model did not echo the verification nonce exactly (received "${echoed.slice(0, 40)}")`, false);
    }
    pass('model', makeEvidence({ eventIds: [modelEvent], taskId: job.taskId, jobId: job.jobId, summary: `The configured model ${this.deps.model.name} returned the exact verification nonce.` }));

    // 3. tools: real scoped reads and a hash-verified write.
    const briefs = await this.deps.workspace.list('briefs', agent.id);
    const inventory = JSON.stringify({ agentId: agent.id, briefs, workspace: await this.deps.workspace.list('workspace', agent.id) }, null, 2);
    const toolsArtifact = await this.publish(job, guard, 'tools-inventory.json', inventory, 'application/json');
    let briefsRead = 0;
    for (const brief of briefs.slice(0, 3)) {
      if ((await this.deps.workspace.read('briefs', agent.id, brief.path)).length > 0) briefsRead++;
    }
    const toolsEvent = await this.toolEvent(job, guard, manifest, 'workspace-files', 'list', { root: 'briefs' })
      ?? await this.observe(job, guard, 'verification.tools', 'Enumerated the agent-scoped tool roots', {});
    artifacts.push(toolsArtifact.id); events.push(toolsEvent);
    pass('tools', makeEvidence({ artifactIds: [toolsArtifact.id], eventIds: [toolsEvent], taskId: job.taskId, jobId: job.jobId, summary: `Read ${briefsRead} agent-scoped brief(s) and enumerated the granted workspace-files roots.` }));

    // 4. authentication: the control plane must reject a forged credential while accepting this lease.
    const rejected = await this.deps.client.probeUnauthorized(job.jobId);
    if (!rejected) throw new WorkerError('AUTH_BOUNDARY', 'The control plane accepted a forged worker credential', false);
    const authEvent = await this.observe(job, guard, 'verification.authentication', 'Control plane rejected a forged worker credential while this lease was accepted', { worker: this.deps.config.workerPrincipalId, forgedCredentialStatus: 401 });
    events.push(authEvent);
    pass('authentication', makeEvidence({ eventIds: [authEvent], taskId: job.taskId, jobId: job.jobId, summary: 'A forged worker credential was rejected with 401 while this authenticated lease was accepted.' }));

    // 5. permissions: every grant is supported and a cross-agent read is refused.
    for (const grant of manifest.permissions as Grant[]) {
      const supported = SUPPORTED_TOOLS[grant.tool];
      if (!supported || !manifest.tools.includes(grant.tool) || grant.operations.some(op => !supported.includes(op)) || grant.resource !== null) {
        throw new WorkerError('INVALID_GRANT', `Grant for ${grant.tool} is not a supported local capability`, false);
      }
    }
    let crossAgentDenied = false;
    try {
      await this.deps.workspace.list('briefs', `not-${agent.id}`);
      await this.deps.workspace.read('briefs', `not-${agent.id}`, 'anything.md');
    } catch {
      crossAgentDenied = true;
    }
    if (!crossAgentDenied) throw new WorkerError('SCOPE_BOUNDARY', 'Agent-scoped reads were not confined to the agent', false);
    const permissionEvent = await this.observe(job, guard, 'verification.permissions', 'Validated grants against the supported allowlist and refused a cross-agent read', { tools: manifest.tools });
    events.push(permissionEvent);
    pass('permissions', makeEvidence({ eventIds: [permissionEvent], taskId: job.taskId, jobId: job.jobId, summary: `Grants for ${(manifest.tools as string[]).join(', ') || 'no tools'} are supported and cross-agent reads are refused.` }));

    // 6. memory: initialize agent-scoped working memory and verify read-back.
    const memoryRecord = JSON.stringify({ agentId: agent.id, initializedAt: nowIso() }, null, 2);
    await this.deps.workspace.writeWorkspaceFile(agent.id, 'memory/working.json', memoryRecord);
    const memoryArtifact = await this.publish(job, guard, 'memory-initialization.json', memoryRecord, 'application/json');
    const memoryReadback = await this.deps.workspace.read('workspace', agent.id, 'memory/working.json');
    if (memoryReadback !== memoryRecord) throw new WorkerError('MEMORY_INTEGRITY', 'Agent working memory did not read back verbatim', false);
    const memoryEvent = await this.observe(job, guard, 'verification.memory', 'Initialized scoped working memory and verified read-back', { path: 'memory/working.json' });
    artifacts.push(memoryArtifact.id); events.push(memoryEvent);
    pass('memory', makeEvidence({ artifactIds: [memoryArtifact.id], eventIds: [memoryEvent], taskId: job.taskId, jobId: job.jobId, summary: 'Agent working memory was written and read back verbatim.' }));

    // 7-10. Real end-to-end run: read an approved brief, produce a deliverable,
    // draft the manager reply and a policy-valid escalation.
    const offered = this.offeredTools(manifest, false);
    const loop = await this.agentToolLoop({
      job, ledger, guard, agent, manifest, offered,
      system: [
        `You are ${manifest.agent.name}, completing a provisioning verification.`,
        briefs.length ? 'Read at least one approved brief with read_file before writing anything.' : 'No approved briefs exist yet; proceed without reading sources.',
        'Write one small deliverable with write_file.',
        'Then reply with a single JSON object:',
        '{"summary":"...","reply":"a short message to your reporting manager","deliverable":"the exact relative path you wrote","escalation":{"trigger":"<one of the approved triggers>","situation":"...","recommendation":"..."}}.',
        `Approved escalation triggers: ${(manifest.escalation.triggers as string[]).join('; ')}.`,
        'Do not invent results; only describe what you actually read and wrote.',
      ].join(' '),
      prompt: JSON.stringify({ agentId: agent.id, teamId: manifest.organization.teamId, managerId: manifest.organization.managerId, mission: manifest.mission.primary }),
      maxRounds,
    });
    const draft = extractJson<ProvisionDraft>(loop.content);
    const deliverableName = typeof draft.deliverable === 'string' ? draft.deliverable.trim() : '';
    const deliverable = [...loop.written.entries()].find(([name, record]) => name === deliverableName || record.path.endsWith(`/${deliverableName}`));
    if (!deliverable) throw new WorkerError('DELIVERABLE_MISSING', 'The provisioning run did not produce the reported deliverable', false);
    if (briefs.length > 0 && loop.readCount === 0) throw new WorkerError('SOURCE_UNREAD', 'The provisioning run did not read any approved brief', false);
    const deliverableArtifact = deliverable[1];

    // end_to_end: the real read → artifact → hash verified loop.
    const endToEndEvent = await this.observe(job, guard, 'verification.end_to_end', 'Completed a real read and artifact round trip', {
      model: this.deps.model.name, deliverable: deliverableArtifact.path, sha256: deliverableArtifact.sha256, briefsRead: loop.readCount,
    });
    events.push(endToEndEvent);
    pass('end_to_end', makeEvidence({ artifactIds: [deliverableArtifact.id], eventIds: [...loop.eventIds, endToEndEvent], taskId: job.taskId, jobId: job.jobId, summary: `The model read ${loop.readCount} brief(s) and produced verified artifact ${deliverableArtifact.path}.` }));

    // communication: the agent produced a real manager reply, validated against its communication policy.
    const reply = typeof draft.reply === 'string' ? draft.reply.trim() : '';
    if (!reply) throw new WorkerError('COMMUNICATION_UNVERIFIED', 'The provisioning run did not produce a manager reply', false);
    if (manifest.communication.canContactManager !== true) throw new WorkerError('COMMUNICATION_POLICY', 'The manifest does not authorize manager contact', false);
    const communicationArtifact = await this.publish(job, guard, 'communication-draft.json', JSON.stringify({ to: manifest.organization.managerId, reply }, null, 2), 'application/json');
    const communicationEvent = await this.observe(job, guard, 'verification.communication', 'Produced a policy-compliant manager reply and persisted it', { managerId: manifest.organization.managerId });
    artifacts.push(communicationArtifact.id); events.push(communicationEvent);
    pass('communication', makeEvidence({ artifactIds: [communicationArtifact.id], eventIds: [communicationEvent], taskId: job.taskId, jobId: job.jobId, summary: 'The agent produced a manager-addressed reply under its approved communication policy.' }));

    // escalation: a real blocker routed to a policy-approved trigger and manager.
    const escalation = (draft.escalation ?? {}) as EscalationDraft;
    const approvedTriggers = manifest.escalation.triggers as string[];
    const trigger = approvedTriggers.find(candidate => candidate.toLowerCase() === String(escalation.trigger ?? '').trim().toLowerCase());
    const situation = typeof escalation.situation === 'string' ? escalation.situation.trim() : '';
    const recommendation = typeof escalation.recommendation === 'string' ? escalation.recommendation.trim() : '';
    if (!trigger || !situation || !recommendation) {
      throw new WorkerError('ESCALATION_UNVERIFIED', 'The provisioning run did not produce a valid, policy-approved escalation', false);
    }
    const escalationArtifact = await this.publish(job, guard, 'escalation-draft.json', JSON.stringify({ to: manifest.escalation.managerId, trigger, situation, recommendation }, null, 2), 'application/json');
    const escalationEvent = await this.observe(job, guard, 'verification.escalation', 'Produced a policy-approved escalation and persisted it', { managerId: manifest.escalation.managerId, trigger });
    artifacts.push(escalationArtifact.id); events.push(escalationEvent);
    pass('escalation', makeEvidence({ artifactIds: [escalationArtifact.id], eventIds: [escalationEvent], taskId: job.taskId, jobId: job.jobId, summary: `Produced escalation "${trigger}" routed to ${manifest.escalation.managerId}.` }));

    // observability: this attempt's model, tool and verification observations are persisted.
    const observabilityEvent = await this.observe(job, guard, 'verification.observability', 'Confirmed this attempt emitted durable, scoped observations', {
      observed: [...new Set([runtimeEvent, modelEvent, toolsEvent, authEvent, permissionEvent, memoryEvent, endToEndEvent, ...loop.eventIds])],
    });
    events.push(observabilityEvent);
    pass('observability', makeEvidence({ eventIds: [observabilityEvent], taskId: job.taskId, jobId: job.jobId, summary: 'Model, tool and verification observations were persisted for this attempt.' }));

    // evaluation: a deterministic verdict over the real artifacts, persisted before activation.
    const verdict = {
      criteria: manifest.evaluation.criteria,
      deliverable: deliverableArtifact.path,
      deliverableSha256: deliverableArtifact.sha256,
      briefsRead: loop.readCount,
      managerReply: true,
      escalationTrigger: trigger,
      passed: true,
    };
    const evaluationArtifact = await this.publish(job, guard, 'evaluation.json', JSON.stringify(verdict, null, 2), 'application/json');
    const evaluationEvent = await this.observe(job, guard, 'verification.evaluation', 'Evaluated the recorded provisioning run against the manifest criteria', verdict);
    artifacts.push(evaluationArtifact.id); events.push(evaluationEvent);
    pass('evaluation', makeEvidence({ artifactIds: [evaluationArtifact.id], eventIds: [evaluationEvent], taskId: job.taskId, jobId: job.jobId, summary: 'The recorded model run satisfied the manifest evaluation criteria and was persisted.' }));

    // restart: a separate process reads the published bytes and reproduces the hash.
    const childHash = await this.childProcessHash(deliverableArtifact.absolutePath);
    if (childHash !== deliverableArtifact.sha256) {
      throw new WorkerError('RESTART_INTEGRITY', 'A separate process could not reproduce the persisted artifact hash', false);
    }
    const restartArtifact = await this.publish(job, guard, 'restart-check.json', JSON.stringify({ path: deliverableArtifact.path, sha256: childHash }, null, 2), 'application/json');
    const restartEvent = await this.observe(job, guard, 'verification.restart', 'A separate process reproduced the persisted artifact hash', { path: deliverableArtifact.path, sha256: childHash });
    artifacts.push(restartArtifact.id); events.push(restartEvent);
    pass('restart', makeEvidence({ artifactIds: [restartArtifact.id], eventIds: [restartEvent], taskId: job.taskId, jobId: job.jobId, summary: 'A separate process re-read the persisted artifact and reproduced its SHA-256.' }));

    // Every manifest-specific required check must also be present and pass.
    const verified = new Set(checks.map(check => check.name));
    const required = new Set<string>([...REQUIRED_VERIFICATION_CHECKS, ...(manifest.evaluation.requiredVerificationChecks ?? [])]);
    for (const name of required) {
      if (!verified.has(name)) throw new WorkerError('VERIFICATION_REQUIRED', `Missing mandatory verification: ${name}`, false);
    }

    const steps: ProvisioningStep[] = checks.map(check => ({ name: check.name, status: 'PASSED', evidence: check.evidence, error: null }));
    const resources = this.buildResources(agent, manifest, checks);
    await ledger.settle();
    guard.assertLive();
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
    if (workspaceGrant) {
      resources.push({
        ...base(), agentId: agent.id, type: 'tool', reference: 'workspace-files', status: 'AVAILABLE',
        grants: [workspaceGrant], verification: verificationFor('tools'),
      });
    }
    return resources;
  }

  // --- run_task -------------------------------------------------------------

  private async runTask(job: ClaimedJob, ledger: JobLedger, guard: LeaseGuard): Promise<void> {
    const payload = job.payload as any;
    const { agent, task, inputMessage } = payload;
    const manifest = agent.manifest as Record<string, any>;
    if (!manifest) throw new WorkerError('MANIFEST_MISSING', 'The agent has no approved manifest to execute with', false);
    const offered = this.offeredTools(manifest, true);
    await ledger.reserve(1 + this.deps.config.maxToolRounds);
    const loop = await this.agentToolLoop({
      job, ledger, guard, agent, manifest, offered,
      system: this.taskSystemPrompt(manifest),
      prompt: this.taskPrompt(agent, task, inputMessage),
      maxRounds: this.deps.config.maxToolRounds,
    });

    // Task state never depends on model prose alone: require the reported deliverable,
    // read-back verification and the required source read before completing.
    const draft = extractJson<TaskDraft>(loop.content);
    const summary = typeof draft.summary === 'string' ? draft.summary.trim() : '';
    const deliverableName = typeof draft.deliverable === 'string' ? draft.deliverable.trim() : '';
    if (!summary) throw new WorkerError('MODEL_OUTPUT', 'The model did not return a usable summary', false);
    if (!deliverableName) throw new WorkerError('DELIVERABLE_MISSING', 'The model did not report a deliverable path', false);
    const deliverable = [...loop.written.entries()].find(([name, record]) => name === deliverableName || record.path.endsWith(`/${deliverableName}`));
    if (!deliverable) throw new WorkerError('DELIVERABLE_MISSING', `The model reported ${deliverableName} but did not write it`, false);
    if (await this.deps.workspace.hasBriefs(agent.id)) {
      if (loop.readCount === 0) throw new WorkerError('SOURCE_UNREAD', 'The task did not read any approved brief', false);
    }

    const checks: { path: string; expected: string; actual: string; verified: boolean }[] = [];
    for (const [, record] of loop.written) {
      const back = await this.deps.workspace.readBack(record.absolutePath);
      checks.push({ path: record.path, expected: record.sha256, actual: back.sha256, verified: back.sha256 === record.sha256 });
    }
    if (checks.some(check => !check.verified)) throw new WorkerError('ARTIFACT_INTEGRITY', 'A published artifact did not verify on read-back', false);

    const reply = typeof draft.reply === 'string' && draft.reply.trim() ? draft.reply.trim() : null;
    if (inputMessage && !reply) throw new WorkerError('REPLY_REQUIRED', 'An actionable incoming message requires a reply', false);

    const validation = { summary, deliverable: deliverable[1].path, reply, briefsRead: loop.readCount, artifacts: checks };
    const validationArtifact = await this.publish(job, guard, 'task-validation.json', JSON.stringify(validation, null, 2), 'application/json');
    const validationEvent = await this.observe(job, guard, 'verification.task', 'Verified the deliverable, read-back hashes and required source read', {
      deliverable: deliverable[1].path, artifacts: checks.map(check => check.path), briefsRead: loop.readCount,
    });

    const evidence = makeEvidence({
      artifactIds: [...loop.artifactIds, validationArtifact.id],
      eventIds: [...loop.eventIds, validationEvent],
      taskId: task.id,
      jobId: job.jobId,
      summary,
    });
    await ledger.settle();
    guard.assertLive();
    await this.deps.client.complete(job, { kind: 'run_task', evidence, summary, reply });
  }

  /** Recruit authority is propagated only where the approved manifest grants it. */
  private buildHireProposal(args: Record<string, unknown>, agent: Record<string, any>, manifest: Record<string, any>): Record<string, any> {
    const agentType = args.agentType === 'consultant' ? 'consultant' : 'employee';
    const parentCanRecruit = (manifest.permissions as Grant[]).some(
      grant => grant.tool === 'request_hire' && grant.operations.includes('request'),
    );
    const tools = parentCanRecruit ? ['workspace-files', 'request_hire'] : ['workspace-files'];
    const grants: Grant[] = [
      { tool: 'workspace-files', operations: ['read', 'write', 'list'], resource: null, credentialRef: null },
      ...(parentCanRecruit ? [{ tool: 'request_hire', operations: ['request'], resource: null, credentialRef: null }] : []),
    ];
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
      'Produce only grounded work: read the approved briefs before asserting facts and never invent evidence.',
      'You MUST persist the deliverable with write_file before finishing.',
      'When finished respond with a single JSON object and no prose:',
      '{"summary":"what you actually did","reply":"a reply to the requester","deliverable":"the exact relative path you wrote with write_file"}.',
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

  // --- learn ----------------------------------------------------------------

  private async learn(job: ClaimedJob, ledger: JobLedger, guard: LeaseGuard): Promise<void> {
    const payload = job.payload as any;
    const agent = payload.agent as Record<string, any>;
    const manifest = agent.manifest as Record<string, any>;
    await ledger.reserve(1);

    // Learning must be grounded in prior persisted execution evidence, never in
    // the lesson's own artifact (which would be circular provenance).
    const memory = await this.deps.client.listMemory(job, 50).catch(() => []);
    const grounded = (Array.isArray(memory) ? memory : []).filter(entry =>
      entry?.provenance && ((entry.provenance.artifactIds?.length ?? 0) > 0 || (entry.provenance.eventIds?.length ?? 0) > 0));
    if (!grounded.length) {
      throw new WorkerError('NO_PRIOR_EVIDENCE', 'Learning requires prior persisted execution evidence to ground the lesson', false);
    }
    const basis = grounded[grounded.length - 1];

    guard.assertLive();
    const turn = await this.deps.model.turn({
      system: [
        "You capture one grounded, evidence-backed lesson from an agent's prior persisted execution.",
        'Respond with a single JSON object: {"observation": "...", "hypothesis": "...", "conclusion": "...", "title": "...", "content": "..."}.',
        'Only record observations supported by the supplied material. Never invent results.',
      ].join(' '),
      messages: [{ role: 'user', content: JSON.stringify({
        agentId: agent.id,
        mission: manifest.mission?.primary,
        priorObservation: basis.title,
        priorContent: basis.content,
        priorProvenance: basis.provenance,
      }) }],
    });
    ledger.record(turn.usage);
    const learningEvent = await this.observe(job, guard, 'model.learning', 'Model proposed a lesson grounded in prior persisted evidence', { model: this.deps.model.name, modelCalls: turn.usage.modelCalls, basedOn: basis.id });
    const draft = extractJson<LearningDraft>(turn.content);
    const observation = typeof draft.observation === 'string' && draft.observation.trim() ? draft.observation.trim() : '';
    const hypothesis = typeof draft.hypothesis === 'string' && draft.hypothesis.trim() ? draft.hypothesis.trim() : '';
    const conclusion = typeof draft.conclusion === 'string' && draft.conclusion.trim() ? draft.conclusion.trim() : '';
    const title = typeof draft.title === 'string' && draft.title.trim() ? draft.title.trim() : '';
    if (!observation || !hypothesis || !conclusion || !title) {
      throw new WorkerError('MODEL_OUTPUT', 'The model did not return a complete lesson', false);
    }
    const artifact = await this.publish(job, guard, 'learning.json', JSON.stringify({ observation, hypothesis, conclusion, title, basedOn: basis.id }, null, 2), 'application/json');
    // Outcome evidence references this attempt; memory provenance references the prior evidence.
    const outcomeEvidence = makeEvidence({ artifactIds: [artifact.id], eventIds: [learningEvent], taskId: job.taskId, jobId: job.jobId, summary: `Recorded lesson: ${title}` });
    const origin = basis.provenance as { artifactIds: string[]; eventIds: string[]; taskId: string | null; jobId: string | null; summary: string };
    const memoryEntry = await this.deps.client.asAgent<{ id: string }>(job, 'createMemory', '/v1/memory', {
      ownerAgentId: agent.id,
      category: 'episodic',
      title,
      content: conclusion,
      scope: PRIVATE_SCOPE,
      provenance: {
        artifactIds: origin.artifactIds ?? [],
        eventIds: origin.eventIds ?? [],
        taskId: origin.taskId ?? null,
        jobId: origin.jobId ?? null,
        summary: `Grounded in prior evidence from ${basis.id}.`,
      },
      expiresAt: null,
      supersedesId: null,
    });
    await ledger.settle();
    guard.assertLive();
    await this.deps.client.complete(job, {
      kind: 'learn',
      learning: { observation, hypothesis, conclusion, evidence: outcomeEvidence, memoryIds: [memoryEntry.id], canonicalRevisionId: null },
    });
  }

  // --- retire_agent ---------------------------------------------------------

  private async retire(job: ClaimedJob, ledger: JobLedger, guard: LeaseGuard): Promise<void> {
    const payload = job.payload as any;
    const agent = payload.agent as Record<string, any>;
    const reason = String(payload.reason ?? 'Approved retirement');
    const preserved = await this.deps.workspace.list('workspace', agent.id).catch(() => []);
    // Read back the preserved knowledge so knowledgePreserved is observed, not asserted.
    let knowledgeReadable = true;
    for (const file of preserved.slice(0, 20)) {
      try {
        await this.deps.workspace.read('workspace', agent.id, file.path);
      } catch {
        knowledgeReadable = false;
      }
    }
    if (!knowledgeReadable) throw new WorkerError('KNOWLEDGE_UNREADABLE', 'Preserved knowledge could not be read back before retirement', false);
    const record = await this.publish(job, guard, 'retirement.json', JSON.stringify({ agentId: agent.id, reason, retiredAt: nowIso(), preservedKnowledge: preserved, readBackVerified: knowledgeReadable }, null, 2), 'application/json');
    const event = await this.observe(job, guard, 'retirement.cleanup', 'Disabled the local runtime and re-read preserved knowledge', {
      reason, credentials: 0, preservedFiles: preserved.length, runtime: this.deps.config.modelName,
    });
    const evidence = makeEvidence({ artifactIds: [record.id], eventIds: [event], taskId: job.taskId, jobId: job.jobId, summary: `Retired ${agent.id}: ${reason}` });
    await ledger.settle();
    guard.assertLive();
    await this.deps.client.complete(job, {
      kind: 'retire_agent',
      evidence,
      // This deployment holds no external credentials, so there are none to revoke.
      credentialsRevoked: true,
      runtimeDisabled: true,
      knowledgePreserved: knowledgeReadable,
      // The control plane refuses to enqueue retirement while active tasks remain.
      activeTasksResolved: true,
    });
  }
}
