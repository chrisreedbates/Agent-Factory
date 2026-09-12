import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import pgDriver from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { migrate, seed, type Queryable } from '@agent-factory/db';
import { manifest as manifestFixture, proposal as proposalFixture, scope } from '@agent-factory/contracts/fixtures';
import { buildApp } from '../src/app.js';
import { REQUIRED_VERIFICATION_CHECKS } from '../src/domain.js';

const operatorToken = 'operator-test-token-at-least-32-chars';
const workerToken = 'worker-test-token-at-least-32-chars';
type Document = Record<string, any>;

async function harness() {
  let db: Queryable;
  let closeDatabase: () => Promise<void>;
  if (process.env.TEST_DATABASE_URL) {
    const pool = new pgDriver.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    const client = await pool.connect();
    const schema = `integration_${randomUUID().replaceAll('-', '')}`;
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    db = client;
    closeDatabase = async () => {
      try { await client.query(`DROP SCHEMA ${schema} CASCADE`); }
      finally { client.release(); await pool.end(); }
    };
  } else {
    const pg = new PGlite();
    db = { async query<T>(sql: string, values?: unknown[]) {
      if (values?.length) return pg.query<T>(sql, values);
      const results = await pg.exec(sql);
      return { rows: (results.at(-1)?.rows ?? []) as T[] };
    } };
    closeDatabase = () => pg.close();
  }
  await migrate(db);
  await seed(db);
  let timestamp = Date.parse('2026-09-12T10:00:00.000Z');
  const config = { db, organizationId: 'org-demo', operatorToken, workerToken,
    artifactRoot: '/tmp/agent-factory-integration-artifacts', now: () => new Date(timestamp) };
  let app = await buildApp(config);
  let sequence = 0;
  async function request(method: 'GET'|'POST', url: string, body?: unknown,
    options: { role?: 'human'|'worker'|'anonymous'; key?: string; headers?: Record<string, string> } = {}) {
    const role = options.role ?? 'human';
    return app.inject({ method, url,
      headers: { ...(role === 'anonymous' ? {} : { authorization: `Bearer ${role === 'worker' ? workerToken : operatorToken}` }),
        ...(method === 'POST' ? { 'idempotency-key': options.key ?? `integration-${++sequence}` } : {}), ...options.headers },
      ...(body === undefined ? {} : { payload: body as any }),
    });
  }
  async function ok(method: 'GET'|'POST', url: string, body?: unknown, options?: Parameters<typeof request>[3]): Promise<Document> {
    const response = await request(method, url, body, options);
    assert.equal(response.statusCode, 200, `${method} ${url}: ${response.body}`);
    return response.json().data;
  }
  async function claim(kind: string): Promise<Document> {
    const job = await ok('POST', '/v1/worker/jobs/claim', { kinds: [kind], leaseSeconds: 60 }, { role: 'worker' });
    assert.ok(job, `Expected queued ${kind} job`);
    return job;
  }
  const lease = (job: Document) => ({ leaseToken: job.leaseToken, attempt: job.attempt });
  async function settleUsage(job: Document) {
    const usage = await ok('POST', `/v1/worker/jobs/${job.jobId}/budget/reserve`, {
      ...lease(job), modelCalls: 1, cost: 0.01, currency: 'USD',
    }, { role: 'worker' });
    await ok('POST', `/v1/worker/jobs/${job.jobId}/budget/settle`, {
      ...lease(job), reservationId: usage.id, modelCalls: 1, inputTokens: null, outputTokens: null, cost: null,
    }, { role: 'worker' });
  }
  async function appendEvidence(job: Document) {
    const event = await ok('POST', `/v1/worker/jobs/${job.jobId}/events`, {
      ...lease(job), type: 'integration.observation', message: 'Synthetic test observation; this does not verify an actual worker.', data: { fixture: true },
    }, { role: 'worker' });
    return { artifactIds: [], eventIds: [event.id], taskId: job.taskId, jobId: job.jobId, summary: 'Persisted integration-test observation.' };
  }
  async function compile(proposal = structuredClone(proposalFixture), options?: Parameters<typeof request>[3]) {
    const hire = await ok('POST', '/v1/hiring-requests', proposal, options);
    const job = await claim('compile_manifest');
    const manifest = structuredClone(manifestFixture);
    manifest.agent.id = hire.agentId;
    manifest.agent.name = proposal.role;
    manifest.role.title = proposal.role;
    manifest.mission.primary = proposal.mission;
    manifest.organization.teamId = proposal.teamId;
    manifest.organization.managerId = proposal.proposedManagerId;
    manifest.organization.managerKind = proposal.proposedManagerKind as 'human'|'agent';
    manifest.escalation.managerId = proposal.proposedManagerId;
    manifest.context.canonicalMemoryIds = ['standards-demo-v1'];
    await settleUsage(job);
    await ok('POST', `/v1/worker/jobs/${job.jobId}/complete`, { ...lease(job), outcome: { kind: 'compile_manifest', manifest } }, { role: 'worker' });
    return { hire: await ok('GET', `/v1/hiring-requests/${hire.id}`), manifest };
  }
  async function approve(hire: Document) {
    return ok('POST', `/v1/hiring-requests/${hire.id}/decision`, {
      decision: 'approve', expectedVersion: hire.version, manifestVersion: hire.manifestVersion, reason: 'Reviewed exact test manifest.',
    });
  }
  async function provisioningOutcome(job: Document) {
    await settleUsage(job);
    const evidence = await appendEvidence(job);
    const checks = REQUIRED_VERIFICATION_CHECKS.map(name => ({ name, passed: true, evidence, error: null }));
    const resource = { id: `resource-${job.jobId}`, organizationId: 'org-demo', version: 1,
      createdAt: new Date(timestamp).toISOString(), updatedAt: new Date(timestamp).toISOString(),
      agentId: job.agentId, type: 'workspace', reference: job.agentId, status: 'AVAILABLE',
      grants: manifestFixture.permissions, verification: checks[0] };
    return { kind: 'provision_agent', steps: [{ name: 'workspace', status: 'PASSED', evidence, error: null }], checks,
      resources: [resource, { ...resource, id: `runtime-${job.jobId}`, type: 'runtime', reference: `test-runtime-${job.agentId}` }] };
  }
  async function activate(proposal = structuredClone(proposalFixture)) {
    const { hire } = await compile(proposal);
    await approve(hire);
    const job = await claim('provision_agent');
    await ok('POST', `/v1/worker/jobs/${job.jobId}/complete`, { ...lease(job), outcome: await provisioningOutcome(job) }, { role: 'worker' });
    return (await ok('GET', `/v1/agents/${hire.agentId}`)).agent as Document;
  }
  return { app, pg: db, db, request, ok, claim, lease, appendEvidence, compile, approve, provisioningOutcome, activate, settleUsage,
    advance: (milliseconds: number) => { timestamp += milliseconds; },
    restart: async () => { await app.close(); app = await buildApp(config); },
    close: async () => { await app.close(); await closeDatabase(); } };
}

test('API seed is empty, authenticated, contract-shaped, and validates caller authority', async () => {
  const h = await harness();
  try {
    const organization = await h.ok('GET', '/v1/organization');
    assert.equal(organization.organization.id, 'org-demo');
    assert.equal(organization.coordinator.id, 'meta-factory');
    assert.deepEqual(organization.agents, []);
    const unauthenticated = await h.request('GET', '/v1/organization', undefined, { role: 'anonymous' });
    assert.equal(unauthenticated.statusCode, 401);
    const spoofed = await h.request('POST', '/v1/hiring-requests', { ...proposalFixture, requestedBy: { id: 'other-human', kind: 'human', organizationId: 'org-demo' } });
    assert.equal(spoofed.statusCode, 400);
    const bareWorker = await h.request('POST', '/v1/hiring-requests', proposalFixture, { role: 'worker' });
    assert.equal(bareWorker.statusCode, 409);
    assert.equal(bareWorker.json().error.code, 'STALE_LEASE');
  } finally { await h.close(); }
});

test('one exact approval gates provisioning and observed checks gate activation', async () => {
  const h = await harness();
  try {
    const { hire } = await h.compile();
    assert.equal(hire.requestedBy.id, 'human-ceo');
    assert.equal(hire.metaAgentId, 'meta-factory');
    assert.equal(hire.status, 'AWAITING_APPROVAL');
    const noProvision = await h.ok('POST', '/v1/worker/jobs/claim', { kinds: ['provision_agent'], leaseSeconds: 60 }, { role: 'worker' });
    assert.equal(noProvision, null);
    const stale = await h.request('POST', `/v1/hiring-requests/${hire.id}/decision`, {
      decision: 'approve', expectedVersion: hire.version, manifestVersion: hire.manifestVersion + 1, reason: 'Stale review.',
    });
    assert.equal(stale.statusCode, 409);
    const workerDecision = await h.request('POST', `/v1/hiring-requests/${hire.id}/decision`, {
      decision: 'approve', expectedVersion: hire.version, manifestVersion: hire.manifestVersion, reason: 'Unauthorized worker review.',
    }, { role: 'worker' });
    assert.equal(workerDecision.statusCode, 403);
    await h.approve(hire);
    const job = await h.claim('provision_agent');
    assert.equal(job.metaAgentId, 'meta-factory');
    assert.equal(job.hiringRequestId, hire.id);
    const missingChecks = await h.request('POST', `/v1/worker/jobs/${job.jobId}/complete`, {
      ...h.lease(job), outcome: { kind: 'provision_agent', steps: [], checks: [], resources: [] },
    }, { role: 'worker' });
    assert.equal(missingChecks.statusCode, 422);
    const outcome = await h.provisioningOutcome(job);
    await h.ok('POST', `/v1/worker/jobs/${job.jobId}/complete`, { ...h.lease(job), outcome }, { role: 'worker', key: 'complete-provision' });
    await h.ok('POST', `/v1/worker/jobs/${job.jobId}/complete`, { ...h.lease(job), outcome }, { role: 'worker', key: 'complete-provision' });
    const agent = (await h.ok('GET', `/v1/agents/${hire.agentId}`)).agent;
    assert.equal(agent.status, 'ACTIVE');
    assert.equal(agent.approvedBy, 'human-ceo');
    assert.equal(agent.approvedManifestVersion, hire.manifestVersion);
    assert.equal(agent.provisionedBy, 'meta-factory');
    const approvals = await h.pg.query<{ count: number }>('SELECT count(*)::integer AS count FROM approvals');
    assert.equal(approvals.rows[0]?.count, 1);
  } finally { await h.close(); }
});

test('concurrent retries create one hire; current leases fence stale owners', async () => {
  const h = await harness();
  try {
    const results = await Promise.all(Array.from({ length: 5 }, () => h.ok('POST', '/v1/hiring-requests', proposalFixture, { key: 'same-hire' })));
    assert.equal(new Set(results.map(hire => hire.id)).size, 1);
    const equivalent = await h.ok('POST', '/v1/hiring-requests', proposalFixture, { key: 'equivalent-hire' });
    assert.equal(equivalent.id, results[0]!.id);
    const claims = await Promise.all(Array.from({ length: 2 }, () => h.ok('POST', '/v1/worker/jobs/claim', { kinds: ['compile_manifest'], leaseSeconds: 10 }, { role: 'worker' })));
    assert.equal(claims.filter(Boolean).length, 1);
    const first = claims.find(Boolean)!;
    h.advance(11_000);
    const replacement = await h.claim('compile_manifest');
    assert.equal(replacement.jobId, first.jobId);
    assert.equal(replacement.attempt, first.attempt + 1);
    assert.notEqual(replacement.leaseToken, first.leaseToken);
    const stale = await h.request('POST', `/v1/worker/jobs/${first.jobId}/events`, {
      ...h.lease(first), type: 'stale.attempt', message: 'Expired attempt must not commit.', data: {},
    }, { role: 'worker' });
    assert.equal(stale.statusCode, 409);
    await h.appendEvidence(replacement);
    const leaked = await h.pg.query<{ count: number }>("SELECT count(*)::integer AS count FROM events WHERE data->>'type'='stale.attempt'");
    assert.equal(leaked.rows[0]?.count, 0);
  } finally { await h.close(); }
});

test('failed provisioning remains inactive and can be explicitly remediated', async () => {
  const h = await harness();
  try {
    const { hire } = await h.compile();
    await h.approve(hire);
    const job = await h.claim('provision_agent');
    await h.ok('POST', `/v1/worker/jobs/${job.jobId}/fail`, {
      ...h.lease(job), code: 'MODEL_UNAVAILABLE', message: 'Deliberate test failure.', retryable: false, evidence: null,
    }, { role: 'worker' });
    const agent = (await h.ok('GET', `/v1/agents/${hire.agentId}`)).agent;
    assert.equal(agent.status, 'REMEDIATING');
    const task = await h.request('POST', '/v1/tasks', {
      agentId: agent.id, objective: 'Cannot start before verification.', constraints: [], deliverable: 'report', deadline: null,
    });
    assert.equal(task.statusCode, 409);
    await h.ok('POST', `/v1/agents/${agent.id}/lifecycle`, { action: 'remediate', expectedVersion: agent.version, reason: 'Test runtime repaired.' });
    const retry = await h.claim('provision_agent');
    await h.ok('POST', `/v1/worker/jobs/${retry.jobId}/complete`, { ...h.lease(retry), outcome: await h.provisioningOutcome(retry) }, { role: 'worker' });
    assert.equal((await h.ok('GET', `/v1/agents/${agent.id}`)).agent.status, 'ACTIVE');
  } finally { await h.close(); }
});

test('budget reservations are atomic, missing cost stays unknown, and cancelled tasks stay terminal', async () => {
  const h = await harness();
  try {
    const agent = await h.activate();
    const task = await h.ok('POST', '/v1/tasks', { agentId: agent.id, objective: 'Exercise budget controls.', constraints: [], deliverable: 'evidence', deadline: null });
    const job = await h.claim('run_task');
    const reservations = await Promise.all(Array.from({ length: 2 }, () => h.request('POST', `/v1/worker/jobs/${job.jobId}/budget/reserve`, {
      ...h.lease(job), modelCalls: 1, cost: 3, currency: 'USD',
    }, { role: 'worker' })));
    assert.deepEqual(reservations.map(r => r.statusCode).sort(), [200, 429]);
    const reservation = reservations.find(r => r.statusCode === 200)!.json().data;
    const usage = await h.ok('POST', `/v1/worker/jobs/${job.jobId}/budget/settle`, {
      ...h.lease(job), reservationId: reservation.id, modelCalls: 1, inputTokens: null, outputTokens: null, cost: null,
    }, { role: 'worker' });
    assert.equal(usage.cost, null);
    assert.equal(usage.status, 'SETTLED');
    const current = await h.ok('GET', `/v1/tasks/${task.id}`);
    await h.ok('POST', `/v1/tasks/${task.id}/cancel`, { expectedVersion: current.version, reason: 'Cancel test work.' });
    const late = await h.request('POST', `/v1/worker/jobs/${job.jobId}/complete`, {
      ...h.lease(job), outcome: { kind: 'run_task', evidence: { artifactIds: [], eventIds: [], taskId: task.id, jobId: job.jobId, summary: 'No evidence.' }, summary: 'Late completion', reply: null },
    }, { role: 'worker' });
    assert.notEqual(late.statusCode, 200);
    assert.equal((await h.ok('GET', `/v1/tasks/${task.id}`)).status, 'CANCELLED');
  } finally { await h.close(); }
});

test('pause blocks admission and retirement requires human governance', async () => {
  const h = await harness();
  try {
    const agent = await h.activate();
    const paused = await h.ok('POST', `/v1/agents/${agent.id}/lifecycle`, { action: 'pause', expectedVersion: agent.version, reason: 'Operator pause.' });
    assert.equal(paused.agent.status, 'PAUSED');
    const rejected = await h.request('POST', '/v1/tasks', { agentId: agent.id, objective: 'Blocked work', constraints: [], deliverable: 'report', deadline: null });
    assert.equal(rejected.statusCode, 409);
    const retirement = await h.ok('POST', `/v1/agents/${agent.id}/lifecycle`, { action: 'retire', expectedVersion: paused.agent.version, reason: 'Governed retirement test.' });
    assert.equal(retirement.governance.status, 'PENDING');
    assert.notEqual(retirement.agent.status, 'ARCHIVED');
    const governance = retirement.governance;
    await h.ok('POST', `/v1/governance/${governance.id}/decision`, { decision: 'approve', expectedVersion: governance.version, reason: 'Approved by the human operator.' });
    const job = await h.claim('retire_agent');
    const evidence = await h.appendEvidence(job);
    const missingCleanup = await h.request('POST', `/v1/worker/jobs/${job.jobId}/complete`, {
      ...h.lease(job), outcome: { kind: 'retire_agent', evidence, credentialsRevoked: false, runtimeDisabled: true, knowledgePreserved: true, activeTasksResolved: true },
    }, { role: 'worker' });
    assert.notEqual(missingCleanup.statusCode, 200);
    await h.ok('POST', `/v1/worker/jobs/${job.jobId}/complete`, {
      ...h.lease(job), outcome: { kind: 'retire_agent', evidence, credentialsRevoked: true, runtimeDisabled: true, knowledgePreserved: true, activeTasksResolved: true },
    }, { role: 'worker' });
    assert.equal((await h.ok('GET', `/v1/agents/${agent.id}`)).agent.status, 'ARCHIVED');
    const memory = await h.ok('GET', '/v1/memory');
    assert.ok(Array.isArray(memory));
    assert.ok(memory.some(entry => entry.id === 'standards-demo-v1'));
  } finally { await h.close(); }
});

const delegated = (job: Document) => ({ role: 'worker' as const, headers: {
  'x-job-id': job.jobId, 'x-lease-token': job.leaseToken, 'x-job-attempt': String(job.attempt),
} });

test('agent-originated hires retain three-generation provenance and cannot self-approve or orphan reports', async () => {
  const h = await harness();
  try {
    let manager = await h.activate();
    const originalManagerId = manager.id;
    for (const role of ['Evidence Analyst', 'Source Reviewer']) {
      const task = await h.ok('POST', '/v1/tasks', { agentId: manager.id, objective: `Identify the need for ${role}.`, constraints: [], deliverable: 'Governed capability-gap proposal', deadline: null });
      let run = await h.claim('run_task');
      // Approval notifications are actionable durable work and may precede this task.
      for (let remaining = 10; run.taskId !== task.id && remaining > 0; remaining--) {
        await h.settleUsage(run);
        const evidence = await h.appendEvidence(run);
        await h.ok('POST', `/v1/worker/jobs/${run.jobId}/complete`, {
          ...h.lease(run), outcome: { kind: 'run_task', evidence, summary: 'Processed synthetic recruitment notification.', reply: 'Acknowledged the recruitment update.' },
        }, { role: 'worker' });
        run = await h.claim('run_task');
      }
      assert.equal(run.agentId, manager.id);
      assert.equal(run.taskId, task.id);
      const proposal = { ...structuredClone(proposalFixture), role, mission: `Perform bounded ${role} work.`,
        proposedManagerId: manager.id, proposedManagerKind: 'agent' };
      const { hire } = await h.compile(proposal, delegated(run));
      assert.equal(hire.requestedBy.kind, 'agent');
      assert.equal(hire.requestedBy.id, manager.id);
      assert.equal(hire.originatingTaskId, task.id);
      assert.equal(hire.originatingJobId, run.jobId);
      assert.equal(hire.proposedManager, manager.id);
      assert.equal(hire.metaAgentId, 'meta-factory');
      const selfApproval = await h.request('POST', `/v1/hiring-requests/${hire.id}/decision`, {
        decision: 'approve', expectedVersion: hire.version, manifestVersion: hire.manifestVersion, reason: 'Worker cannot approve itself.',
      }, delegated(run));
      assert.equal(selfApproval.statusCode, 403);
      await h.approve(hire);
      const provision = await h.claim('provision_agent');
      await h.ok('POST', `/v1/worker/jobs/${provision.jobId}/complete`, { ...h.lease(provision), outcome: await h.provisioningOutcome(provision) }, { role: 'worker' });
      manager = (await h.ok('GET', `/v1/agents/${hire.agentId}`)).agent;
      assert.equal(manager.manifest.organization.managerId, hire.requestedBy.id);
      assert.equal(manager.provisionedBy, 'meta-factory');
    }
    const root = (await h.ok('GET', `/v1/agents/${originalManagerId}`)).agent;
    const retirement = await h.ok('POST', `/v1/agents/${root.id}/lifecycle`, { action: 'retire', expectedVersion: root.version, reason: 'Would orphan active reports.' });
    const gov = retirement.governance;
    const orphaning = await h.request('POST', `/v1/governance/${gov.id}/decision`, { decision: 'approve', expectedVersion: gov.version, reason: 'Attempted orphaning retirement.' });
    assert.equal(orphaning.statusCode, 409);
    assert.equal((await h.ok('GET', `/v1/agents/${root.id}`)).agent.status, 'ACTIVE');
  } finally { await h.close(); }
});

test('actionable messages create one execution and persist a correlated reply', async () => {
  const h = await harness();
  try {
    const agent = await h.activate();
    const input = { recipientId: agent.id, recipientKind: 'agent', content: 'Read the approved source and reply with your result.', actionable: true, inReplyTo: null, taskId: null };
    const first = await h.ok('POST', '/v1/messages', input, { key: 'message-retry' });
    const second = await h.ok('POST', '/v1/messages', input, { key: 'message-retry' });
    assert.equal(first.id, second.id);
    assert.equal(first.taskId, second.taskId);
    assert.ok(first.inputJobId);
    const job = await h.claim('run_task');
    assert.equal(job.inputMessageId, first.id);
    assert.equal(job.taskId, first.taskId);
    const evidence = await h.appendEvidence(job);
    await h.settleUsage(job);
    await h.ok('POST', `/v1/worker/jobs/${job.jobId}/complete`, {
      ...h.lease(job), outcome: { kind: 'run_task', evidence, summary: 'Verified test observation persisted.', reply: 'The requested test result is ready.' },
    }, { role: 'worker' });
    const messages = await h.ok('GET', '/v1/messages');
    assert.ok(Array.isArray(messages));
    assert.equal(messages.find(row => row.id === first.id)?.deliveryStatus, 'replied');
    const reply = messages.find(row => row.inReplyTo === first.id);
    assert.equal(reply?.recipientId, 'human-ceo');
    assert.equal(reply?.sender.id, agent.id);
    const tasks = await h.pg.query<{ count: number }>("SELECT count(*)::integer AS count FROM tasks WHERE data->>'inputMessageId'=$1", [first.id]);
    assert.equal(tasks.rows[0]?.count, 1);
    assert.equal(await h.ok('POST', '/v1/worker/jobs/claim', { kinds: ['run_task'], leaseSeconds: 60 }, { role: 'worker' }), null);
  } finally { await h.close(); }
});

test('escalation fences the terminal run and resolution creates linked follow-up work', async () => {
  const h = await harness();
  try {
    const agent = await h.activate();
    const taskInput = { agentId: agent.id, objective: 'Review a missing source.', constraints: [], deliverable: 'Cited review', deadline: null };
    const task = await h.ok('POST', '/v1/tasks', taskInput);
    const run = await h.claim('run_task');
    const escalation = await h.ok('POST', '/v1/escalations', { agentId: agent.id, taskId: task.id, severity: 'medium', category: 'missing_source', situation: 'Source is unavailable.', attemptedActions: ['Checked approved sources.'], reason: 'Cannot substantiate the claim.', recommendation: 'Provide an approved source.', requestedFrom: 'human-ceo' }, delegated(run));
    assert.equal((await h.ok('GET', `/v1/tasks/${task.id}`)).status, 'ESCALATED');
    const stale = await h.request('POST', `/v1/worker/jobs/${run.jobId}/renew`, { ...h.lease(run), leaseSeconds: 60 }, { role: 'worker' });
    assert.equal(stale.statusCode, 409);
    const resolved = await h.ok('POST', `/v1/escalations/${escalation.id}/resolve`, {
      expectedVersion: escalation.version, resolution: 'Approved source supplied.', followUp: { ...taskInput, objective: 'Review the newly supplied source.' },
    });
    assert.ok(resolved.followUpTaskId);
    assert.notEqual(resolved.followUpTaskId, task.id);
    assert.equal((await h.ok('GET', `/v1/tasks/${task.id}`)).status, 'ESCALATED');
    assert.equal((await h.ok('GET', `/v1/tasks/${resolved.followUpTaskId}`)).parentTaskId, task.id);
  } finally { await h.close(); }
});

test('canonical knowledge revisions require explicit approval and preserve previous content', async () => {
  const h = await harness();
  try {
    const prior = await h.ok('GET', '/v1/memory/standards-demo-v1');
    const revision = await h.ok('POST', '/v1/memory', { ownerAgentId: null, category: 'canonical', title: 'Reviewed operating standards', content: 'Retain evidence for every accepted result.', scope, provenance: { artifactIds: [], eventIds: [], taskId: null, jobId: null, summary: 'Explicit human policy proposal.' }, expiresAt: null, supersedesId: prior.id });
    assert.equal(revision.status, 'PROPOSED');
    assert.equal((await h.ok('GET', `/v1/memory/${prior.id}`)).status, 'ACTIVE');
    const proposals = await h.ok('GET', '/v1/governance');
    assert.ok(Array.isArray(proposals));
    const governance = proposals.find(row => row.kind === 'canonical_revision' && row.changes.memoryId === revision.id)!;
    assert.ok(governance);
    await h.ok('POST', `/v1/governance/${governance.id}/decision`, { decision: 'approve', expectedVersion: governance.version, reason: 'Reviewed the exact policy content.' });
    const retained = await h.ok('GET', `/v1/memory/${prior.id}`);
    assert.equal(retained.status, 'SUPERSEDED');
    assert.equal(retained.content, prior.content);
    assert.equal((await h.ok('GET', `/v1/memory/${revision.id}`)).status, 'ACTIVE');
  } finally { await h.close(); }
});

test('API recreation retains manifests, approvals, tasks, messages, memory, usage and audit history', async () => {
  const h = await harness();
  try {
    const agent = await h.activate();
    const task = await h.ok('POST', '/v1/tasks', { agentId: agent.id, objective: 'Store durable operational state.', constraints: [], deliverable: 'Restart evidence', deadline: null });
    const job = await h.claim('run_task');
    await h.settleUsage(job);
    const evidence = await h.appendEvidence(job);
    await h.ok('POST', '/v1/memory', { ownerAgentId: agent.id, category: 'episodic', title: 'Durability observation', content: 'This fixture verifies storage survives API recreation.', scope, provenance: evidence, expiresAt: null, supersedesId: null }, delegated(job));
    await h.ok('POST', '/v1/messages', { recipientId: 'human-ceo', recipientKind: 'human', content: 'Durability fixture recorded.', actionable: false, inReplyTo: null, taskId: task.id }, delegated(job));
    const paths = [`/v1/agents/${agent.id}`, `/v1/tasks/${task.id}`, '/v1/hiring-requests', '/v1/messages', '/v1/memory', '/v1/usage', '/v1/events'];
    const before = await Promise.all(paths.map(path => h.ok('GET', path)));
    const approvalsBefore = await h.pg.query('SELECT * FROM approvals ORDER BY id');
    await h.restart();
    const after = await Promise.all(paths.map(path => h.ok('GET', path)));
    assert.deepEqual(after, before);
    const approvalsAfter = await h.pg.query('SELECT * FROM approvals ORDER BY id');
    assert.deepEqual(approvalsAfter.rows, approvalsBefore.rows);
    const renewal = await h.ok('POST', `/v1/worker/jobs/${job.jobId}/renew`, { ...h.lease(job), leaseSeconds: 60 }, { role: 'worker' });
    assert.ok(renewal.leaseExpiresAt);
  } finally { await h.close(); }
});

test('a provisioning lease cannot delegate its verification sends', async () => {
  const h = await harness();
  try {
    const { hire } = await h.compile();
    await h.approve(hire);
    const job = await h.claim('provision_agent');
    // The provisioning lease itself is current and accepted...
    const renewal = await h.ok('POST', `/v1/worker/jobs/${job.jobId}/renew`, { ...h.lease(job), leaseSeconds: 60 }, { role: 'worker' });
    assert.ok(renewal.leaseExpiresAt);
    // ...yet the control plane refuses to let it act as the not-yet-ACTIVE agent.
    const message = await h.request('POST', '/v1/messages', {
      recipientId: 'human-ceo', recipientKind: 'human', content: 'Provisioning verification.', actionable: false, inReplyTo: null, taskId: null,
    }, delegated(job));
    assert.equal(message.statusCode, 403);
    assert.equal(message.json().error.code, 'DELEGATION_FORBIDDEN');
    const escalation = await h.request('POST', '/v1/escalations', {
      agentId: hire.agentId, taskId: null, severity: 'medium', category: 'missing evidence', situation: 'Source unavailable.', attemptedActions: ['Read the approved brief.'], reason: 'Cannot substantiate.', recommendation: 'Supply the source.', requestedFrom: 'human-ceo',
    }, delegated(job));
    assert.equal(escalation.statusCode, 403);
    assert.equal(escalation.json().error.code, 'DELEGATION_FORBIDDEN');
    // The worker's own lease-authenticated surface still works.
    const event = await h.ok('POST', `/v1/worker/jobs/${job.jobId}/events`, { ...h.lease(job), type: 'boundary.probe', message: 'The worker lease itself is valid.', data: {} }, { role: 'worker' });
    assert.ok(event.id);
  } finally { await h.close(); }
});
