import { randomUUID } from 'node:crypto';
import { Agent, Task, Message, HiringRequest, Organization, Team } from '@agent-factory/contracts';
import { readArtifact } from './artifacts.js';
import { Store, digest, type Actor, type RecordData } from './store.js';
import {
  DomainError, assertAgentTransition, assertTaskTransition, assertWorkAdmission,
  assertRetirementAllowed, assertSupportedGrants, assertCommunicationScope,
  assertVerificationEvidence, assertTaskCompletionEvidence, type Evidence,
} from './domain.js';

const MAX_ATTEMPTS = 3;
const terminalTasks = new Set(['COMPLETED', 'FAILED', 'ESCALATED', 'CANCELLED']);
const contractRecord = (schema: { properties: Record<string, unknown> }, record: RecordData) =>
  Object.fromEntries(Object.keys(schema.properties).map(key => [key, record[key]]));

export async function enqueue(store: Store, input: {
  kind: string; agentId: string; taskId?: string | null; hiringRequestId?: string | null;
  inputMessageId?: string | null; idempotencyKey: string; payload: RecordData;
}): Promise<RecordData> {
  const existing = (await store.list('jobs')).find(job => job.idempotencyKey === input.idempotencyKey);
  if (existing) return existing;
  const org = await store.get('organizations', store.organizationId);
  const id = randomUUID();
  return store.insert('jobs', {
    ...input, jobId: id, taskId: input.taskId ?? null, hiringRequestId: input.hiringRequestId ?? null,
    inputMessageId: input.inputMessageId ?? null, metaAgentId: org.metaAgentId,
    payloadVersion: 1, status: 'QUEUED', attempt: 0, leaseToken: null,
    leaseExpiresAt: null, workerPrincipalId: null, outcomeDigest: null, lastFailure: null,
  }, id);
}

/** Every entry point is called inside the application's organization transaction. */
export class WorkerService {
  constructor(public store: Store, public config: { artifactRoot: string; workerPrincipalId: string }) {}

  async handle(operationId: string, id: string | undefined, body: RecordData, actor: Actor): Promise<any> {
    if (actor.kind !== 'worker' || actor.organizationId !== this.store.organizationId) {
      throw new DomainError('WORKER_REQUIRED', 'Worker authentication is required', 403);
    }
    switch (operationId) {
      case 'claimJob': return this.claim(body, actor);
      case 'renewJob': return this.renew(id!, body, actor);
      case 'appendJobEvent': return this.appendEvent(id!, body, actor);
      case 'completeJob': return this.complete(id!, body, actor);
      case 'failJob': return this.fail(id!, body, actor);
      case 'reserveBudget': return this.reserve(id!, body, actor);
      case 'settleBudget': return this.settle(id!, body, actor);
      case 'publishArtifact': return this.publish(id!, body, actor);
      case 'verifyProvisionCommunication': return this.verifyProvisionCommunication(id!, body, actor);
      default: throw new DomainError('NOT_FOUND', 'Unknown worker operation', 404);
    }
  }

  async fence(id: string, body: RecordData, actor: Actor, terminal = false): Promise<RecordData> {
    const job = await this.store.get('jobs', id);
    if (job.attempt !== body.attempt || job.leaseToken !== body.leaseToken || job.workerPrincipalId !== actor.id) {
      throw new DomainError('STALE_LEASE', 'The job lease belongs to another attempt or worker');
    }
    if (terminal && (['COMPLETED', 'FAILED'].includes(job.status) || (job.status === 'QUEUED' && job.failureDigest))) return job;
    if (job.status !== 'RUNNING' || Date.parse(job.leaseExpiresAt) <= this.store.now().getTime()) {
      throw new DomainError('STALE_LEASE', 'The job lease is no longer valid');
    }
    return job;
  }

  private context(job: RecordData, actor?: Actor) {
    return { agentId: job.agentId, taskId: job.taskId, jobId: job.id, attempt: job.attempt,
      hiringRequestId: job.hiringRequestId, executedBy: actor?.id ?? job.workerPrincipalId };
  }

  async provisioningCommunicationContext(id: string, body: RecordData, actor: Actor) {
    const job = await this.fence(id, body, actor);
    if (!['provision_agent', 'reconfigure_agent'].includes(job.kind)) {
      throw new DomainError('DELEGATION_FORBIDDEN', 'Communication verification requires a provisioning or reconfiguration job', 403);
    }
    const agent = await this.store.get('agents', job.agentId);
    if (job.cancellationRequested || agent.cancellationRequested) throw new DomainError('EXECUTION_CANCELLED', 'Provisioning is cancelled');
    if (!['PROVISIONING', 'RECONFIGURING', 'VERIFYING'].includes(agent.status)) throw new DomainError('AGENT_STATE', 'Communication verification requires an in-progress provisioning attempt');
    if (!agent.approvedBy || !Number.isInteger(job.payload.manifestVersion) || agent.manifestVersion !== job.payload.manifestVersion || agent.approvedManifestVersion !== job.payload.manifestVersion) {
      throw new DomainError('MANIFEST_NOT_APPROVED', 'Verification requires the exact approved job manifest');
    }
    const { managerId, managerKind } = agent.manifest.organization;
    const manager = await this.store.get(managerKind === 'agent' ? 'agents' : 'principals', managerId);
    if (managerKind === 'agent') assertWorkAdmission(manager as any);
    else if (manager.kind !== 'human') throw new DomainError('INVALID_PRINCIPAL', 'The approved manager must be a human or agent', 403);
    assertCommunicationScope({ id: agent.id, kind: 'agent', organizationId: agent.organizationId,
      managerId, communication: agent.manifest.communication },
    { id: manager.id, kind: managerKind, organizationId: manager.organizationId });
    return { job, agent, managerId, managerKind };
  }

  private async verifyProvisionCommunication(id: string, body: RecordData, actor: Actor) {
    const { job, agent, managerId, managerKind } = await this.provisioningCommunicationContext(id, body, actor);
    // One real, non-actionable probe per fenced attempt, even across different retry keys.
    const probeId = `provision-communication-${job.id}-${job.attempt}`;
    const previous = await this.store.maybe('messages', probeId);
    if (previous) return { message: previous, escalation: await this.store.get('escalations', probeId) };
    const message = await this.store.insert('messages', {
      sender: { id: agent.id, kind: 'agent', organizationId: agent.organizationId },
      recipientId: managerId, recipientKind: managerKind,
      content: 'Provisioning verification: testing the approved manager communication and escalation path. No work is requested.',
      actionable: false, inReplyTo: null, taskId: null, inputJobId: job.id,
      deliveryStatus: 'queued', blockedReason: null,
    }, probeId);
    const escalation = await this.store.insert('escalations', {
      agentId: agent.id, taskId: null, severity: 'low', category: 'provisioning_verification',
      situation: 'Provisioning verification of the approved manager escalation path.',
      attemptedActions: ['Persisted a non-actionable communication probe to the approved manager.'],
      reason: 'Verify escalation persistence before activation.', recommendation: 'Review and resolve this verification probe; no operational task is blocked.',
      requestedFrom: managerId, status: 'OPEN', resolution: null, resolvedBy: null, followUpTaskId: null,
    }, probeId);
    await this.store.event('provisioning.communication_verified', 'Persisted manager message and escalation verification probes.',
      this.context(job, actor), { messageId: message.id, escalationId: escalation.id, manifestVersion: job.payload.manifestVersion });
    return { message, escalation };
  }

  private async refreshActivity(agentId: string) {
    const agent = await this.store.get('agents', agentId);
    const jobs = (await this.store.list('jobs')).filter(job => job.agentId === agentId);
    const working = jobs.some(job => job.status === 'RUNNING' && Date.parse(job.leaseExpiresAt) > this.store.now().getTime());
    const queued = jobs.some(job => job.status === 'QUEUED');
    const activity = ['PAUSED', 'REMEDIATING', 'TERMINATING', 'REJECTED'].includes(agent.status) ? 'blocked' :
      working ? 'working' : queued ? 'queued' : 'idle';
    return agent.activity === activity ? agent : this.store.save('agents', { ...agent, activity });
  }

  private async transitionAgent(agent: RecordData, status: string) {
    if (agent.status !== status) {
      assertAgentTransition(agent.status, status);
      agent = await this.store.save('agents', { ...agent, status });
      await this.store.event('agent.transition', `Agent entered ${status}`, { agentId: agent.id, hiringRequestId: agent.hiringRequestId }, { status });
    }
    return agent;
  }

  private async transitionTask(task: RecordData, status: string) {
    if (task.status !== status) {
      assertTaskTransition(task.status, status);
      task = await this.store.save('tasks', { ...task, status });
      await this.store.event('task.transition', `Task entered ${status}`, { agentId: task.agentId, taskId: task.id }, { status });
    }
    return task;
  }

  private async notify(agent: RecordData, content: string) {
    const requester = agent.requestedBy;
    if (!requester || !['human', 'agent'].includes(requester.kind)) return;
    const org = await this.store.get('organizations', this.store.organizationId);
    const recipient = requester.kind === 'agent' ? await this.store.maybe('agents', requester.id) : null;
    await this.store.insert('messages', {
      sender: { id: org.metaAgentId, kind: 'factory', organizationId: this.store.organizationId },
      recipientId: requester.id, recipientKind: requester.kind, content,
      actionable: requester.kind === 'agent', inReplyTo: null, taskId: null, inputJobId: null,
      deliveryStatus: requester.kind === 'human' || recipient?.status === 'ACTIVE' ? 'queued' : 'blocked',
      blockedReason: requester.kind === 'agent' && recipient?.status !== 'ACTIVE' ? 'Recipient is not ACTIVE' : null,
    });
  }

  private async hasQueueCapacity(agent: RecordData) {
    const pending = (await this.store.list('jobs')).filter(job => job.agentId === agent.id &&
      ['run_task', 'learn'].includes(job.kind) && ['QUEUED', 'RUNNING'].includes(job.status)).length;
    return pending < agent.manifest.budget.maxConcurrentTasks;
  }

  private async dispatchMessages() {
    for (const message of await this.store.list('messages')) {
      if (!message.actionable || message.recipientKind !== 'agent' || message.taskId || !['queued', 'blocked'].includes(message.deliveryStatus)) continue;
      const agent = await this.store.maybe('agents', message.recipientId);
      if (!agent || agent.status !== 'ACTIVE' || agent.cancellationRequested || agent.budgetExceeded) continue;
      if (!await this.hasQueueCapacity(agent)) {
        if (message.deliveryStatus !== 'blocked' || message.blockedReason !== 'Agent is at task capacity') {
          await this.store.save('messages', { ...message, deliveryStatus: 'blocked', blockedReason: 'Agent is at task capacity' });
        }
        continue;
      }
      const task = await this.store.insert('tasks', {
        agentId: agent.id, objective: message.content, constraints: [], deliverable: 'Reply to the incoming message',
        deadline: null, parentTaskId: null, inputMessageId: message.id, status: 'CREATED',
        requestedBy: message.sender, executedBy: null, evidence: null, cancellationRequested: false,
      });
      const job = await enqueue(this.store, { kind: 'run_task', agentId: agent.id, taskId: task.id,
        hiringRequestId: agent.hiringRequestId, inputMessageId: message.id,
        idempotencyKey: `message:${message.id}`, payload: {} });
      await this.store.save('messages', { ...message, taskId: task.id, inputJobId: job.id, deliveryStatus: 'queued', blockedReason: null });
    }
  }

  private async dispatchSchedules() {
    const now = this.store.now().getTime();
    for (const schedule of await this.store.list('schedules')) {
      if (!schedule.enabled || Date.parse(schedule.nextRunAt) > now) continue;
      const agent = await this.store.maybe('agents', schedule.agentId);
      if (!agent || agent.status !== 'ACTIVE' || agent.cancellationRequested || agent.budgetExceeded || !await this.hasQueueCapacity(agent)) continue;
      if (!Number.isInteger(schedule.intervalSeconds) || schedule.intervalSeconds < 60) {
        await this.store.save('schedules', { ...schedule, enabled: false });
        await this.store.event('schedule.invalid', 'Schedule disabled because its interval is invalid', { agentId: agent.id });
        continue;
      }
      let task: RecordData | null = null;
      if (schedule.kind === 'run_task') {
        const payload = schedule.payload;
        if (typeof payload.objective !== 'string' || !payload.objective.trim() || typeof payload.deliverable !== 'string' || !payload.deliverable.trim()) {
          await this.store.save('schedules', { ...schedule, enabled: false });
          await this.store.event('schedule.invalid', 'Schedule requires an objective and deliverable', { agentId: agent.id });
          continue;
        }
        task = await this.store.insert('tasks', {
          agentId: agent.id, objective: payload.objective, constraints: payload.constraints ?? [], deliverable: payload.deliverable,
          deadline: payload.deadline ?? null, parentTaskId: null, inputMessageId: null, status: 'CREATED',
          requestedBy: { id: agent.metaAgentId, kind: 'factory', organizationId: this.store.organizationId },
          executedBy: null, evidence: null, cancellationRequested: false,
        });
      }
      await enqueue(this.store, { kind: schedule.kind, agentId: agent.id, taskId: task?.id,
        hiringRequestId: agent.hiringRequestId, idempotencyKey: `schedule:${schedule.id}:${schedule.nextRunAt}`, payload: {} });
      const interval = schedule.intervalSeconds * 1000;
      const next = Date.parse(schedule.nextRunAt) + (Math.floor((now - Date.parse(schedule.nextRunAt)) / interval) + 1) * interval;
      await this.store.save('schedules', { ...schedule, nextRunAt: new Date(next).toISOString() });
    }
  }

  private async currentGrants(agent: RecordData) {
    assertSupportedGrants(agent.manifest);
    const active = (await this.store.list('grants')).filter(grant => grant.agentId === agent.id && grant.status === 'ACTIVE');
    for (const permission of agent.manifest.permissions) {
      if (!active.some(grant => grant.tool === permission.tool && grant.resource === permission.resource &&
        grant.credentialRef === permission.credentialRef && permission.operations.every((op: string) => grant.operations.includes(op)))) {
        throw new DomainError('GRANT_REVOKED', 'Current grants no longer authorize the approved execution scope', 403);
      }
    }
    return active;
  }

  private async claim(body: RecordData, actor: Actor) {
    await this.dispatchMessages();
    await this.dispatchSchedules();
    const jobs = await this.store.list('jobs');
    for (let job of jobs) {
      if (!body.kinds.includes(job.kind)) continue;
      const expired = job.status === 'RUNNING' && Date.parse(job.leaseExpiresAt) <= this.store.now().getTime();
      if (job.status !== 'QUEUED' && !expired) continue;
      let agent = await this.store.get('agents', job.agentId);
      if (agent.budgetExceeded && job.kind !== 'retire_agent') continue;
      if (['run_task', 'learn'].includes(job.kind) && (agent.status !== 'ACTIVE' || agent.cancellationRequested)) continue;
      if (['run_task', 'learn'].includes(job.kind) && agent.manifest?.agent.type === 'consultant' &&
        agent.manifest.consultant?.deadline && Date.parse(agent.manifest.consultant.deadline) <= this.store.now().getTime()) {
        await this.transitionAgent(agent, 'PAUSED');
        await this.store.event('consultant.deadline', 'Consultant deadline reached; execution is paused for human review', { agentId: agent.id });
        continue;
      }
      if (['run_task', 'learn'].includes(job.kind)) {
        await this.currentGrants(agent);
        const running = jobs.filter(other => other.id !== job.id && other.agentId === agent.id && ['run_task', 'learn'].includes(other.kind) && other.status === 'RUNNING' && Date.parse(other.leaseExpiresAt) > this.store.now().getTime()).length;
        if (running >= agent.manifest.budget.maxConcurrentTasks) continue;
      }
      if (job.attempt >= MAX_ATTEMPTS) {
        await this.exhaust(job, agent);
        continue;
      }
      if (['provision_agent', 'reconfigure_agent'].includes(job.kind)) {
        if (agent.approvedManifestVersion !== job.payload.manifestVersion || agent.manifestVersion !== job.payload.manifestVersion) {
          await this.store.save('jobs', { ...job, status: 'FAILED', lastFailure: 'Manifest approval no longer matches the job' });
          continue;
        }
        if (!['PROVISIONING', 'RECONFIGURING', 'REMEDIATING'].includes(agent.status)) continue;
        if (agent.status === 'REMEDIATING') agent = await this.transitionAgent(agent, 'PROVISIONING');
      }
      if (job.kind === 'compile_manifest') {
        if (!['REQUESTED', 'SPECIFYING', 'REMEDIATING'].includes(agent.status)) continue;
        agent = await this.transitionAgent(agent, 'SPECIFYING');
      }
      if (job.kind === 'retire_agent' && agent.status !== 'TERMINATING') continue;
      if (expired) await this.store.event('job.recovered', 'Expired lease reclaimed with a new fencing token', this.context(job));
      job = await this.store.save('jobs', { ...job, status: 'RUNNING', attempt: job.attempt + 1,
        leaseToken: randomUUID(), leaseExpiresAt: new Date(this.store.now().getTime() + body.leaseSeconds * 1000).toISOString(),
        workerPrincipalId: actor.id, outcomeDigest: null });
      if (job.taskId) {
        let task = await this.store.get('tasks', job.taskId);
        if (terminalTasks.has(task.status) || task.cancellationRequested) {
          await this.store.save('jobs', { ...job, status: 'FAILED', lastFailure: 'Task is terminal or cancelled' });
          continue;
        }
        if (task.status === 'CREATED') task = await this.transitionTask(task, 'PLANNING');
        if (task.status === 'PLANNING' || task.status === 'RETRYING') task = await this.transitionTask(task, 'EXECUTING');
        await this.store.save('tasks', { ...task, executedBy: actor.id });
      }
      if (job.inputMessageId) {
        const message = await this.store.get('messages', job.inputMessageId);
        await this.store.save('messages', { ...message, deliveryStatus: 'consumed', blockedReason: null });
      }
      await this.store.event('job.claimed', 'Worker claimed a job', this.context(job, actor));
      agent = await this.refreshActivity(agent.id);
      return this.envelope(job, agent);
    }
    return null;
  }

  private async envelope(job: RecordData, agent: RecordData) {
    const cleanAgent = contractRecord(Agent, agent);
    let payload: RecordData;
    switch (job.kind) {
      case 'compile_manifest': payload = {
        hiringRequest: contractRecord(HiringRequest, await this.store.get('hiring_requests', job.hiringRequestId)),
        agent: cleanAgent, organization: contractRecord(Organization, await this.store.get('organizations', this.store.organizationId)),
        teams: (await this.store.list('teams')).map(team => contractRecord(Team, team)),
      }; break;
      case 'provision_agent': case 'reconfigure_agent': payload = { agent: cleanAgent, manifest: agent.manifest, manifestVersion: job.payload.manifestVersion }; break;
      case 'run_task': payload = { agent: cleanAgent, task: contractRecord(Task, await this.store.get('tasks', job.taskId)),
        inputMessage: job.inputMessageId ? contractRecord(Message, await this.store.get('messages', job.inputMessageId)) : null }; break;
      case 'retire_agent': payload = { agent: cleanAgent, reason: job.payload.reason ?? 'Approved retirement' }; break;
      default: payload = { agent: cleanAgent };
    }
    return { jobId: job.id, kind: job.kind, payloadVersion: 1, organizationId: job.organizationId,
      agentId: job.agentId, taskId: job.taskId, metaAgentId: job.metaAgentId,
      hiringRequestId: job.hiringRequestId, inputMessageId: job.inputMessageId,
      idempotencyKey: job.idempotencyKey, attempt: job.attempt,
      leaseToken: job.leaseToken, leaseExpiresAt: job.leaseExpiresAt, payload };
  }

  private async renew(id: string, body: RecordData, actor: Actor) {
    const job = await this.fence(id, body, actor);
    const leaseExpiresAt = new Date(this.store.now().getTime() + body.leaseSeconds * 1000).toISOString();
    await this.store.save('jobs', { ...job, leaseExpiresAt });
    return { leaseExpiresAt };
  }

  private async appendEvent(id: string, body: RecordData, actor: Actor) {
    const job = await this.fence(id, body, actor);
    if (body.type.startsWith('model.') || body.type.startsWith('tool.')) {
      const reservations = (await this.store.list('usage_reservations')).filter(usage => usage.jobId === job.id && usage.attempt === job.attempt && usage.status === 'RESERVED');
      if (!reservations.length) throw new DomainError('RESERVATION_REQUIRED', 'Reserve budget before recording model or tool execution', 403);
      const agent = await this.store.get('agents', job.agentId);
      if (body.type.startsWith('tool.')) {
        const permission = agent.manifest?.permissions.find((grant: RecordData) => grant.tool === body.data.tool && grant.operations.includes(body.data.operation));
        if (!permission) throw new DomainError('TOOL_FORBIDDEN', 'Tool event requires an approved tool and operation', 403);
        if (['run_task', 'learn'].includes(job.kind)) await this.currentGrants(agent);
      }
    }
    return this.store.event(body.type, body.message, this.context(job, actor), body.data);
  }

  async evidence(job: RecordData, evidence: Evidence) {
    assertTaskCompletionEvidence(evidence);
    if (evidence.jobId !== job.id || evidence.taskId !== (job.taskId ?? null)) {
      throw new DomainError('EVIDENCE_SCOPE', 'Evidence must reference the current job and task', 422);
    }
    for (const [table, ids] of [['artifacts', evidence.artifactIds], ['events', evidence.eventIds]] as const) {
      for (const id of ids) {
        const record = await this.store.get(table, id);
        if (record.agentId !== job.agentId || record.jobId !== job.id || record.attempt !== job.attempt) {
          throw new DomainError('EVIDENCE_SCOPE', 'Evidence must belong to the current agent, job and fenced attempt', 422);
        }
        if (table === 'artifacts') await readArtifact(this.config.artifactRoot, record.path, { size: record.size, sha256: record.sha256 }, `${job.agentId}/${job.id}/${job.attempt}/`);
      }
    }
  }

  private async validateManifest(agent: RecordData, manifest: RecordData) {
    const { Service } = await import('./service.js');
    await new Service(this.store, { id: this.config.workerPrincipalId, kind: 'worker', organizationId: this.store.organizationId }, this.config.artifactRoot).validateManifest(manifest, agent.id);
  }

  private async complete(id: string, body: RecordData, actor: Actor) {
    const job = await this.fence(id, body, actor, true);
    const outcomeDigest = digest(body.outcome);
    if (job.status === 'COMPLETED') {
      if (job.outcomeDigest !== outcomeDigest) throw new DomainError('OUTCOME_CONFLICT', 'A different outcome already completed this attempt');
      return { jobId: job.id, status: 'COMPLETED', duplicate: true };
    }
    if (['FAILED', 'QUEUED'].includes(job.status)) throw new DomainError('JOB_TERMINAL', 'An attempt that already failed cannot complete');
    if (body.outcome.kind !== job.kind) throw new DomainError('OUTCOME_KIND', 'Outcome kind does not match this job', 422);
    let agent = await this.store.get('agents', job.agentId);
    const outcome = body.outcome;
    let consultantCompleted = false;
    if (agent.budgetExceeded && job.kind !== 'retire_agent') throw new DomainError('BUDGET_EXCEEDED', 'Execution is blocked until human budget governance resolves the overrun', 429);
    if (job.kind !== 'retire_agent') {
      const usage = (await this.store.list('usage_reservations')).filter(u => u.jobId === job.id && u.attempt === job.attempt);
      if (!usage.some(u => u.status === 'SETTLED') || usage.some(u => u.status === 'RESERVED')) {
        throw new DomainError('USAGE_SETTLEMENT_REQUIRED', 'Execution requires settled usage for this attempt and no outstanding reservations', 422);
      }
    }
    if (job.kind === 'compile_manifest') {
      if (agent.status !== 'SPECIFYING') throw new DomainError('AGENT_STATE', 'Compilation is not admitted in the current lifecycle state');
      await this.validateManifest(agent, outcome.manifest);
      const version = (agent.manifestVersion ?? 0) + 1;
      await this.store.insert('manifests', { agentId: agent.id, version, manifestVersion: version, manifest: outcome.manifest, approvedBy: null });
      agent = await this.store.save('agents', { ...agent, manifest: outcome.manifest, manifestVersion: version });
      agent = await this.transitionAgent(agent, 'AWAITING_APPROVAL');
      const hire = await this.store.get('hiring_requests', job.hiringRequestId);
      await this.store.save('hiring_requests', { ...hire, manifest: outcome.manifest, manifestVersion: version, status: 'AWAITING_APPROVAL' });
    } else if (['provision_agent', 'reconfigure_agent'].includes(job.kind)) {
      if (!['PROVISIONING', 'RECONFIGURING', 'VERIFYING'].includes(agent.status)) throw new DomainError('AGENT_STATE', 'Provisioning is not admitted in the current lifecycle state');
      assertVerificationEvidence({ manifestVersion: agent.manifestVersion, approvedManifestVersion: agent.approvedManifestVersion,
        checks: outcome.checks, requiredChecks: agent.manifest.evaluation.requiredVerificationChecks });
      if (agent.manifestVersion !== job.payload.manifestVersion) throw new DomainError('MANIFEST_NOT_APPROVED', 'Provisioning job uses a stale manifest');
      if (!outcome.steps.length || outcome.steps.some((step: RecordData) => step.status !== 'PASSED' || step.error !== null || !step.evidence)) {
        throw new DomainError('PROVISIONING_INCOMPLETE', 'Every supplied provisioning step must have passed with evidence', 422);
      }
      for (const step of outcome.steps) await this.evidence(job, step.evidence);
      for (const check of outcome.checks) await this.evidence(job, check.evidence);
      const evaluation = outcome.checks.find((check: RecordData) => check.name === 'evaluation');
      await this.store.insert('evaluations', { agentId: agent.id, taskId: null,
        criteria: agent.manifest.evaluation.criteria.join('; ') || 'Runtime-reported provisioning evaluation',
        passed: true, score: null, evidence: evaluation.evidence });
      for (const resource of outcome.resources) {
        if (resource.type === 'credential') throw new DomainError('TOOL_UNAVAILABLE', 'External credentials are unavailable in this deployment', 422);
        if (resource.agentId !== agent.id || resource.organizationId !== agent.organizationId || resource.status !== 'AVAILABLE') {
          throw new DomainError('RESOURCE_SCOPE', 'Provisioned resources must be available and owned by this agent', 422);
        }
        for (const grant of resource.grants) {
          if (!agent.manifest.permissions.some((approved: RecordData) => approved.tool === grant.tool &&
            approved.resource === grant.resource && approved.credentialRef === grant.credentialRef &&
            grant.operations.every((op: string) => approved.operations.includes(op)))) {
            throw new DomainError('RESOURCE_GRANT', 'Resource grants exceed the approved manifest', 422);
          }
        }
        if (resource.verification) {
          if (!resource.verification.passed || resource.verification.error !== null) throw new DomainError('RESOURCE_VERIFICATION', 'Resource verification did not pass', 422);
          await this.evidence(job, resource.verification.evidence);
        }
      }
      if (!['workspace', 'runtime'].every(type => outcome.resources.some((resource: RecordData) => resource.type === type))) {
        throw new DomainError('RESOURCE_REQUIRED', 'Verified workspace and runtime resources are required', 422);
      }
      agent = await this.transitionAgent(agent, 'VERIFYING');
      for (const existing of (await this.store.list('grants')).filter(g => g.agentId === agent.id && g.status === 'ACTIVE')) {
        await this.store.save('grants', { ...existing, status: 'REVOKED' });
      }
      for (const grant of agent.manifest.permissions) await this.store.insert('grants', { agentId: agent.id, ...grant, status: 'ACTIVE' });
      for (const resource of outcome.resources) {
        const { id: _id, organizationId: _org, version: _version, createdAt: _created, updatedAt: _updated, ...values } = resource;
        await this.store.insert('resources', values);
      }
      agent = await this.store.save('agents', { ...agent, verification: outcome.checks, provisionedBy: job.metaAgentId, cancellationRequested: false });
      agent = await this.transitionAgent(agent, 'ACTIVE');
      const hire = await this.store.get('hiring_requests', agent.hiringRequestId);
      await this.store.save('hiring_requests', { ...hire, status: 'ACTIVE', provisionedBy: job.metaAgentId });
      await this.notify(agent, `Recruit ${agent.manifest?.agent.name ?? agent.id} (${agent.id}) is ACTIVE and available for delegated work.`);
    } else if (job.kind === 'run_task') {
      assertWorkAdmission(agent as any);
      let task = await this.store.get('tasks', job.taskId);
      if (agent.cancellationRequested || task.cancellationRequested || terminalTasks.has(task.status)) throw new DomainError('TASK_CANCELLED', 'Cancelled or terminal work cannot complete');
      await this.evidence(job, outcome.evidence);
      await this.store.insert('evaluations', { agentId: agent.id, taskId: task.id,
        criteria: 'Control-plane admission of runtime-reported task completion evidence',
        passed: true, score: null, evidence: outcome.evidence });
      if (job.inputMessageId && !outcome.reply?.trim()) throw new DomainError('REPLY_REQUIRED', 'An actionable incoming message requires a reply', 422);
      task = await this.transitionTask(task, 'VERIFYING');
      task = await this.store.save('tasks', { ...task, evidence: outcome.evidence, executedBy: actor.id });
      await this.transitionTask(task, 'COMPLETED');
      if (agent.manifest.agent.type === 'consultant') {
        agent = await this.transitionAgent(agent, 'PAUSED');
        consultantCompleted = true;
      }
      if (outcome.reply) {
        const input = job.inputMessageId ? await this.store.get('messages', job.inputMessageId) : null;
        const originalRecipient = input?.sender ?? task.requestedBy;
        const recipient = originalRecipient.kind === 'factory'
          ? { id: (await this.store.get('organizations', this.store.organizationId)).humanPrincipalId, kind: 'human' }
          : originalRecipient;
        if (['agent', 'human'].includes(recipient.kind)) {
          await this.store.insert('messages', { sender: { id: agent.id, kind: 'agent', organizationId: agent.organizationId },
            recipientId: recipient.id, recipientKind: recipient.kind, content: outcome.reply, actionable: false,
            inReplyTo: input?.id ?? null, taskId: task.id, inputJobId: job.id, deliveryStatus: 'queued', blockedReason: null });
        }
        if (input) await this.store.save('messages', { ...input, deliveryStatus: 'replied', blockedReason: null });
      }
    } else if (job.kind === 'learn') {
      assertWorkAdmission(agent as any);
      if (agent.cancellationRequested) throw new DomainError('AGENT_INACTIVE', 'Agent has cancellation intent');
      await this.evidence(job, outcome.learning.evidence);
      for (const memoryId of outcome.learning.memoryIds) {
        const memory = await this.store.get('memory_entries', memoryId);
        if (memory.ownerAgentId !== agent.id) throw new DomainError('MEMORY_FORBIDDEN', 'Learning may link only the agent’s own tactical memory', 403);
      }
      if (outcome.learning.canonicalRevisionId) {
        const revision = await this.store.get('memory_entries', outcome.learning.canonicalRevisionId);
        if (revision.ownerAgentId !== agent.id || revision.provenance?.jobId !== job.id) throw new DomainError('MEMORY_FORBIDDEN', 'Canonical learning must reference this agent’s current learning proposal', 403);
        if (revision.category !== 'canonical' || revision.status !== 'PROPOSED') throw new DomainError('APPROVAL_REQUIRED', 'Canonical learning requires a proposed revision', 403);
      }
      await this.store.insert('learning_proposals', { agentId: agent.id, ...outcome.learning });
    } else if (job.kind === 'retire_agent') {
      if (agent.status !== 'TERMINATING') throw new DomainError('AGENT_STATE', 'Only approved terminating agents can be retired');
      await this.evidence(job, outcome.evidence);
      if (!outcome.credentialsRevoked || !outcome.runtimeDisabled || !outcome.knowledgePreserved || !outcome.activeTasksResolved) {
        throw new DomainError('RETIREMENT_INCOMPLETE', 'Retirement cleanup evidence must confirm every required operation', 422);
      }
      const reports = (await this.store.list('agents')).map(a => ({ id: a.id,
        organizationId: a.organizationId, teamId: a.manifest?.organization.teamId ?? a.teamId,
        managerId: a.manifest?.organization.managerId ?? a.managerId, status: a.status }));
      assertRetirementAllowed(agent.id, reports);
      if ((await this.store.list('tasks')).some(task => task.agentId === agent.id && !terminalTasks.has(task.status))) {
        throw new DomainError('ACTIVE_TASKS', 'Resolve active tasks before retiring this agent');
      }
      for (const table of ['resources', 'grants'] as const) {
        for (const resource of (await this.store.list(table)).filter(record => record.agentId === agent.id)) {
          await this.store.save(table, { ...resource, status: 'REVOKED' });
        }
      }
      for (const schedule of (await this.store.list('schedules')).filter(s => s.agentId === agent.id)) {
        await this.store.save('schedules', { ...schedule, enabled: false });
      }
      agent = await this.transitionAgent(agent, 'ARCHIVED');
      await this.notify(agent, `Recruit ${agent.manifest?.agent.name ?? agent.id} (${agent.id}) was archived; its durable history is preserved.`);
    }
    await this.store.save('jobs', { ...job, status: 'COMPLETED', outcomeDigest });
    agent = await this.refreshActivity(agent.id);
    if (consultantCompleted) {
      await this.store.insert('governance', {
        agentId: agent.id, kind: 'retire', expectedVersion: agent.version,
        reason: 'The bounded consultant mission completed; review retirement and knowledge preservation.',
        changes: {}, requestedBy: { id: job.metaAgentId, kind: 'factory', organizationId: agent.organizationId },
        status: 'PENDING', approvedBy: null,
      });
    }
    await this.store.event('job.completed', 'Worker outcome accepted', this.context(job, actor));
    return { jobId: job.id, status: 'COMPLETED', duplicate: false };
  }

  private async exhaust(job: RecordData, agent: RecordData) {
    await this.store.save('jobs', { ...job, status: 'FAILED', lastFailure: 'Retry limit exhausted' });
    if (job.taskId) {
      const task = await this.store.get('tasks', job.taskId);
      if (!terminalTasks.has(task.status)) await this.transitionTask(task, 'FAILED');
    } else if (['compile_manifest', 'provision_agent', 'reconfigure_agent'].includes(job.kind) && !['ARCHIVED', 'TERMINATING', 'REMEDIATING'].includes(agent.status)) {
      await this.transitionAgent(agent, 'REMEDIATING');
    }
    await this.refreshActivity(agent.id);
    await this.store.event('job.exhausted', 'Job retry limit exhausted; human remediation is required', this.context(job));
  }

  private async fail(id: string, body: RecordData, actor: Actor) {
    const job = await this.fence(id, body, actor, true);
    const failureDigest = digest({ code: body.code, message: body.message, retryable: body.retryable, evidence: body.evidence });
    if (job.status === 'FAILED' || job.status === 'QUEUED') {
      if (job.failureDigest !== failureDigest) throw new DomainError('OUTCOME_CONFLICT', 'A different failure already ended this job');
      return { jobId: job.id, status: job.status, duplicate: true };
    }
    if (job.status === 'COMPLETED') throw new DomainError('JOB_TERMINAL', 'A completed job cannot fail');
    if (body.evidence) await this.evidence(job, body.evidence);
    const retry = body.retryable && job.attempt < MAX_ATTEMPTS;
    await this.store.save('jobs', { ...job, status: retry ? 'QUEUED' : 'FAILED', lastFailure: { code: body.code, message: body.message }, failureDigest });
    const agent = await this.store.get('agents', job.agentId);
    if (['compile_manifest', 'provision_agent', 'reconfigure_agent'].includes(job.kind) && ['SPECIFYING', 'PROVISIONING', 'RECONFIGURING', 'VERIFYING'].includes(agent.status)) {
      await this.transitionAgent(agent, 'REMEDIATING');
      const hire = await this.store.get('hiring_requests', agent.hiringRequestId);
      await this.store.save('hiring_requests', { ...hire, status: 'FAILED' });
      if (!retry) await this.notify(agent, `Recruitment of ${agent.id} failed and requires human remediation: ${body.code}.`);
    }
    if (job.taskId) {
      let task = await this.store.get('tasks', job.taskId);
      if (!terminalTasks.has(task.status)) {
        if (retry) {
          if (task.status === 'EXECUTING') task = await this.transitionTask(task, 'VERIFYING');
          if (task.status === 'VERIFYING') await this.transitionTask(task, 'RETRYING');
        } else await this.transitionTask(task, 'FAILED');
      }
    }
    if (!retry && job.inputMessageId) {
      const message = await this.store.get('messages', job.inputMessageId);
      await this.store.save('messages', { ...message, deliveryStatus: 'failed', blockedReason: body.code });
    }
    await this.refreshActivity(agent.id);
    await this.store.event('job.failed', body.message, this.context(job, actor), { code: body.code, retryable: retry });
    return { jobId: job.id, status: retry ? 'QUEUED' : 'FAILED', duplicate: false };
  }

  private async publish(id: string, body: RecordData, actor: Actor) {
    const job = await this.fence(id, body, actor);
    const agent = await this.store.get('agents', job.agentId);
    if (body.scope.visibility === 'team' && (!body.scope.teamId || body.scope.teamId !== agent.manifest?.organization.teamId)) {
      throw new DomainError('ARTIFACT_SCOPE_DENIED', 'Team artifacts must belong to the agent’s team', 403);
    }
    if (body.scope.teamId) {
      await this.store.get('teams', body.scope.teamId);
      if (body.scope.teamId !== agent.manifest?.organization.teamId) throw new DomainError('ARTIFACT_SCOPE_DENIED', 'Cannot publish into another team', 403);
    }
    for (const recipientId of body.scope.agentIds) {
      const recipient = await this.store.get('agents', recipientId);
      assertCommunicationScope({ id: agent.id, kind: 'agent', organizationId: agent.organizationId,
        teamId: agent.manifest?.organization.teamId, managerId: agent.manifest?.organization.managerId,
        communication: agent.manifest?.communication },
      { id: recipient.id, kind: 'agent', organizationId: recipient.organizationId,
        teamId: recipient.manifest?.organization.teamId, managerId: recipient.manifest?.organization.managerId });
    }
    await readArtifact(this.config.artifactRoot, body.path, { size: body.size, sha256: body.sha256 }, `${agent.id}/${job.id}/${job.attempt}/`);
    const existing = (await this.store.list('artifacts')).find(artifact => artifact.path === body.path);
    if (existing) {
      if (existing.jobId !== job.id || existing.attempt !== job.attempt || existing.sha256 !== body.sha256 || existing.size !== body.size ||
          existing.contentType !== body.contentType || digest(existing.scope) !== digest(body.scope)) {
        throw new DomainError('ARTIFACT_IMMUTABLE', 'Accepted artifact metadata and bytes cannot be replaced');
      }
      return existing;
    }
    return this.store.insert('artifacts', { agentId: agent.id, jobId: job.id, attempt: job.attempt,
      path: body.path, contentType: body.contentType, size: body.size, sha256: body.sha256, scope: body.scope });
  }

  private async reserve(id: string, body: RecordData, actor: Actor) {
    const job = await this.fence(id, body, actor);
    const agent = await this.store.get('agents', job.agentId);
    if (['run_task', 'learn'].includes(job.kind)) {
      assertWorkAdmission(agent as any);
      if (agent.cancellationRequested) throw new DomainError('AGENT_INACTIVE', 'Agent has cancellation intent');
      await this.currentGrants(agent);
    }
    if (agent.budgetExceeded) throw new DomainError('BUDGET_EXCEEDED', 'Human budget governance must resolve the prior overrun', 429);
    const hire = agent.manifest ? null : await this.store.get('hiring_requests', agent.hiringRequestId);
    const budget = agent.manifest?.budget ?? hire?.proposal.budget;
    if (!budget || body.currency !== budget.currency) throw new DomainError('BUDGET_CURRENCY', 'Reservation currency must match the agent budget', 422);
    const org = await this.store.get('organizations', this.store.organizationId);
    const today = this.store.timestamp().slice(0, 10);
    const usage = (await this.store.list('usage_reservations')).filter(u => u.status !== 'RELEASED' && u.createdAt.slice(0, 10) === today);
    // Organization-wide limits cannot safely add amounts denominated in different currencies.
    if (usage.some(u => u.currency !== body.currency)) throw new DomainError('BUDGET_CURRENCY', 'Organization daily reservations must use one currency', 422);
    const accounted = (u: RecordData) => u.status === 'RESERVED' || u.cost === null ? u.reservedCost : u.cost;
    const own = usage.filter(u => u.agentId === agent.id);
    const calls = own.reduce((sum, u) => sum + u.modelCalls, 0);
    const ownCost = own.reduce((sum, u) => sum + accounted(u), 0);
    const orgCost = usage.reduce((sum, u) => sum + accounted(u), 0);
    if (calls + body.modelCalls > budget.modelCallsDaily || ownCost + body.cost > budget.externalSpendDaily || orgCost + body.cost > org.limits.maxDailySpend) {
      throw new DomainError('BUDGET_EXCEEDED', 'Budget reservation exceeds an agent or organization daily limit', 429);
    }
    return this.store.insert('usage_reservations', { agentId: agent.id, jobId: job.id, attempt: job.attempt,
      modelCalls: body.modelCalls, inputTokens: null, outputTokens: null, cost: null,
      currency: body.currency, status: 'RESERVED', reservedCost: body.cost });
  }

  private async settle(id: string, body: RecordData, actor: Actor) {
    const job = await this.fence(id, body, actor);
    const reservation = await this.store.get('usage_reservations', body.reservationId);
    if (reservation.jobId !== job.id || reservation.agentId !== job.agentId || reservation.attempt !== job.attempt) {
      throw new DomainError('RESERVATION_SCOPE', 'Reservation belongs to another job or attempt', 403);
    }
    const settlementDigest = digest({ modelCalls: body.modelCalls, inputTokens: body.inputTokens, outputTokens: body.outputTokens, cost: body.cost });
    if (reservation.status === 'SETTLED') {
      if (reservation.settlementDigest !== settlementDigest) throw new DomainError('SETTLEMENT_CONFLICT', 'Reservation was already settled with different usage');
      return reservation;
    }
    if (reservation.status !== 'RESERVED') throw new DomainError('RESERVATION_STATE', 'Reservation is no longer unsettled');
    const updated = await this.store.save('usage_reservations', { ...reservation, modelCalls: body.modelCalls,
      inputTokens: body.inputTokens, outputTokens: body.outputTokens, cost: body.cost, status: 'SETTLED', settlementDigest });
    if (body.modelCalls > reservation.modelCalls || (body.cost !== null && body.cost > reservation.reservedCost)) {
      let agent = await this.store.get('agents', job.agentId);
      agent = await this.store.save('agents', { ...agent, budgetExceeded: true, cancellationRequested: true });
      if (agent.status === 'ACTIVE') agent = await this.transitionAgent(agent, 'PAUSED');
      else if (['SPECIFYING', 'PROVISIONING', 'VERIFYING', 'RECONFIGURING'].includes(agent.status)) agent = await this.transitionAgent(agent, 'REMEDIATING');
      const org = await this.store.get('organizations', this.store.organizationId);
      await this.store.insert('escalations', { agentId: agent.id, taskId: job.taskId, severity: 'high', category: 'budget_overrun',
        situation: 'Actual recorded usage exceeded the execution reservation.', attemptedActions: ['Preserved actual usage and blocked further execution'],
        reason: 'Budget authority was exceeded', recommendation: 'Review actual usage and approve a revised budget before resuming.',
        requestedFrom: org.humanPrincipalId, status: 'OPEN', resolution: null, resolvedBy: null, followUpTaskId: null });
      await this.store.event('budget.overrun', 'Actual usage exceeded its reservation; human review is required before further execution', this.context(job, actor));
    }
    return updated;
  }
}
