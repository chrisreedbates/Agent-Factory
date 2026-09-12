import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { migrate, seed, type Queryable } from '@agent-factory/db';
import { manifest, agent, hire, task as taskFixture } from '@agent-factory/contracts/fixtures';
import { Store, transaction, type RecordData } from '../src/store.js';
import { WorkerService, enqueue } from '../src/worker.js';
import { DomainError } from '../src/domain.js';
import { Service } from '../src/service.js';

// Deliberately initialized policy fixtures, never demo seed data or runtime evidence.
async function harness(status = 'ACTIVE') {
  const pg = new PGlite();
  const db: Queryable = { async query<T>(sql: string, values?: unknown[]) {
    if (values?.length) return pg.query<T>(sql, values);
    const result = await pg.exec(sql);
    return { rows: (result.at(-1)?.rows ?? []) as T[] };
  } };
  await migrate(db); await seed(db);
  let time = Date.parse('2026-09-12T10:00:00.000Z');
  const now = () => new Date(time);
  const artifactRoot = await mkdtemp(join(tmpdir(), 'agent-factory-worker-'));
  const actor = { id: 'worker-local', kind: 'worker', organizationId: 'org-demo' };
  const tx = <T>(fn: (store: Store) => Promise<T>) => transaction(db, 'org-demo', fn, now);
  await tx(async s => {
    await s.insert('agents', { ...agent, status, approvedManifestVersion: 1, approvedBy: 'human-ceo' }, agent.id);
    await s.insert('hiring_requests', { ...hire, status: 'APPROVED', approvedManifestVersion: 1 }, hire.id);
    for (const grant of manifest.permissions) await s.insert('grants', { ...grant, agentId: agent.id, status: 'ACTIVE' });
  });
  const call = (operation: string, body: RecordData, id?: string, workerId = actor.id) =>
    tx(s => new WorkerService(s, { artifactRoot, workerPrincipalId: actor.id }).handle(operation, id, body, { ...actor, id: workerId }));
  const lease = (job: RecordData) => ({ leaseToken: job.leaseToken, attempt: job.attempt });
  const queue = async (kind = 'run_task', extra: RecordData = {}) => tx(async s => {
    const task = kind === 'run_task' ? await s.insert('tasks', { ...taskFixture, ...extra }) : null;
    return enqueue(s, { kind, agentId: agent.id, hiringRequestId: hire.id, taskId: task?.id,
      idempotencyKey: `test:${kind}:${task?.id ?? Math.random()}`, payload: { manifestVersion: 1 } });
  });
  const claim = (kind = 'run_task', workerId?: string) => call('claimJob', { kinds: [kind], leaseSeconds: 10 }, undefined, workerId);
  const observe = async (job: RecordData) => {
    const event = await call('appendJobEvent', { ...lease(job), type: 'test.observation', message: 'Policy-test observation; no actual model execution.', data: {} }, job.jobId);
    return { artifactIds: [], eventIds: [event.id], jobId: job.jobId, taskId: job.taskId, summary: 'Persisted fixture observation.' };
  };
  const settle = async (job: RecordData, cost: number | null = null) => {
    const usage = await call('reserveBudget', { ...lease(job), modelCalls: 1, cost: 0.01, currency: 'USD' }, job.jobId);
    return call('settleBudget', { ...lease(job), reservationId: usage.id, modelCalls: 1, inputTokens: null, outputTokens: null, cost }, job.jobId);
  };
  return { pg, db, tx, actor, call, lease, queue, claim, observe, settle, artifactRoot,
    advance: (ms: number) => { time += ms; },
    close: async () => { await pg.close(); await rm(artifactRoot, { recursive: true, force: true }); } };
}
const rejectsCode = (run: () => Promise<unknown>, code: string) => assert.rejects(run, (e: unknown) => e instanceof DomainError && e.code === code);

test('job claims serialize and expired attempts cannot renew, write events or complete', async () => {
  const h = await harness();
  try {
    await h.queue();
    const claims = await Promise.all([h.claim(), h.claim(undefined, 'worker-other')]);
    assert.equal(claims.filter(Boolean).length, 1);
    const first = claims.find(Boolean)!;
    assert.equal(first.payload.agent.activity, 'working');
    h.advance(11_000);
    const next = await h.claim();
    assert.equal(next.jobId, first.jobId); assert.equal(next.attempt, 2);
    await rejectsCode(() => h.call('renewJob', { ...h.lease(first), leaseSeconds: 10 }, first.jobId), 'STALE_LEASE');
    await rejectsCode(() => h.call('appendJobEvent', { ...h.lease(first), type: 'stale', message: 'must reject', data: {} }, first.jobId), 'STALE_LEASE');
    const evidence = await h.observe(next); await h.settle(next);
    const outcome = { kind: 'run_task', evidence, summary: 'Test policy completion', reply: null };
    await rejectsCode(() => h.call('completeJob', { ...h.lease(first), outcome }, first.jobId), 'STALE_LEASE');
    assert.equal((await h.call('completeJob', { ...h.lease(next), outcome }, next.jobId)).duplicate, false);
    assert.equal((await h.tx(s => s.get('agents', agent.id))).activity, 'idle');
    assert.equal((await h.tx(s => s.list('evaluations'))).length, 1);
    assert.equal((await h.call('completeJob', { ...h.lease(next), outcome }, next.jobId)).duplicate, true);
    await rejectsCode(() => h.call('completeJob', { ...h.lease(next), outcome: { ...outcome, summary: 'changed' } }, next.jobId), 'OUTCOME_CONFLICT');
  } finally { await h.close(); }
});

test('retryable failure is idempotent and exhausted jobs stop retrying', async () => {
  const h = await harness();
  try {
    await h.queue();
    let job = await h.claim();
    for (let attempt = 1; attempt <= 3; attempt++) {
      assert.equal(job.attempt, attempt);
      const failure = { ...h.lease(job), code: 'TEST_FAILURE', message: 'Deliberate policy failure', retryable: true, evidence: null };
      const receipt = await h.call('failJob', failure, job.jobId);
      assert.equal(receipt.status, attempt < 3 ? 'QUEUED' : 'FAILED');
      assert.equal((await h.call('failJob', failure, job.jobId)).duplicate, true);
      if (attempt < 3) {
        assert.equal(await h.claim(), null);
        h.advance(5_001);
        job = await h.claim();
      }
    }
    assert.equal(await h.claim(), null);
    assert.equal((await h.tx(s => s.get('tasks', job.taskId))).status, 'FAILED');
  } finally { await h.close(); }
});

test('execution observations need reservations and approved tools, and completion requires settled usage', async () => {
  const h = await harness();
  try {
    await h.queue(); const job = await h.claim();
    const event = { ...h.lease(job), type: 'model.completed', message: 'Test event', data: {} };
    await rejectsCode(() => h.call('appendJobEvent', event, job.jobId), 'RESERVATION_REQUIRED');
    const evidence = await h.observe(job);
    const completion = { ...h.lease(job), outcome: { kind: 'run_task', evidence, summary: 'fixture', reply: null } };
    await rejectsCode(() => h.call('completeJob', completion, job.jobId), 'USAGE_SETTLEMENT_REQUIRED');
    const reservation = await h.call('reserveBudget', { ...h.lease(job), modelCalls: 1, cost: 0.1, currency: 'USD' }, job.jobId);
    await h.call('appendJobEvent', event, job.jobId);
    await rejectsCode(() => h.call('appendJobEvent', { ...event, type: 'tool.completed', data: { tool: 'shell', operation: 'execute' } }, job.jobId), 'TOOL_FORBIDDEN');
    await h.call('appendJobEvent', { ...event, type: 'tool.completed', data: { tool: 'workspace-files', operation: 'read' } }, job.jobId);
    await h.call('settleBudget', { ...h.lease(job), reservationId: reservation.id, modelCalls: 1, inputTokens: null, outputTokens: null, cost: null }, job.jobId);
    await h.call('completeJob', completion, job.jobId);
  } finally { await h.close(); }
});

test('wrong-attempt evidence and revoked grants are rejected', async () => {
  const h = await harness();
  try {
    await h.queue(); const first = await h.claim(); const oldEvidence = await h.observe(first);
    h.advance(11_000); const next = await h.claim(); await h.settle(next);
    await rejectsCode(() => h.call('completeJob', { ...h.lease(next), outcome: { kind: 'run_task', evidence: oldEvidence, summary: 'wrong attempt', reply: null } }, next.jobId), 'EVIDENCE_SCOPE');
    await h.tx(async s => {
      for (const grant of await s.list('grants')) await s.save('grants', { ...grant, status: 'REVOKED' });
    });
    await rejectsCode(() => h.call('reserveBudget', { ...h.lease(next), modelCalls: 1, cost: 0.1, currency: 'USD' }, next.jobId), 'GRANT_REVOKED');
  } finally { await h.close(); }
});

test('blocked actionable messages create one linked task when active and require a reply', async () => {
  const h = await harness('PAUSED');
  try {
    const message = await h.tx(s => s.insert('messages', { sender: { id: 'meta-factory', kind: 'factory', organizationId: 'org-demo' }, recipientId: agent.id, recipientKind: 'agent',
      content: 'Reply with the source review', actionable: true, inReplyTo: null, taskId: null, inputJobId: null,
      deliveryStatus: 'blocked', blockedReason: 'Paused' }));
    assert.equal(await h.claim(), null);
    await h.tx(async s => { const row = await s.get('agents', agent.id); await s.save('agents', { ...row, status: 'ACTIVE' }); });
    const job = await h.claim(); assert.equal(job.inputMessageId, message.id);
    assert.equal(await h.claim(), null);
    const evidence = await h.observe(job); await h.settle(job);
    const outcome = { kind: 'run_task', evidence, summary: 'policy fixture', reply: null };
    await rejectsCode(() => h.call('completeJob', { ...h.lease(job), outcome }, job.jobId), 'REPLY_REQUIRED');
    await h.call('completeJob', { ...h.lease(job), outcome: { ...outcome, reply: 'Here is the source review.' } }, job.jobId);
    const messages = await h.tx(s => s.list('messages'));
    assert.equal(messages.find(m => m.id === message.id)?.deliveryStatus, 'replied');
    assert.equal(messages.filter(m => m.inReplyTo === message.id).length, 1);
    assert.equal(messages.find(m => m.inReplyTo === message.id)?.recipientId, 'human-ceo');
    assert.equal(messages.find(m => m.inReplyTo === message.id)?.recipientKind, 'human');
    assert.equal((await h.tx(s => s.list('tasks'))).length, 1);
  } finally { await h.close(); }
});

test('durable schedules dispatch one tick and preserve paused work', async () => {
  const h = await harness();
  try {
    await h.tx(s => s.insert('schedules', { agentId: agent.id, kind: 'learn', intervalSeconds: 60,
      nextRunAt: '2026-09-12T09:00:00.000Z', enabled: true, payload: {} }));
    const jobs = await Promise.all([h.claim('learn'), h.claim('learn')]);
    assert.equal(jobs.filter(Boolean).length, 1);
    assert.equal((await h.tx(s => s.list('jobs'))).length, 1);
    const schedules = await h.tx(s => s.list('schedules'));
    assert.equal(schedules[0]!.nextRunAt, '2026-09-12T10:01:00.000Z');
  } finally { await h.close(); }
});

test('artifact publication uses current attempt, immutable real bytes and detects subsequent tampering', async () => {
  const h = await harness();
  try {
    await h.queue(); const job = await h.claim();
    const path = `${agent.id}/${job.jobId}/${job.attempt}/report.md`;
    const directory = join(h.artifactRoot, agent.id, job.jobId, String(job.attempt));
    await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'report.md'), 'verified test bytes');
    const publication = { ...h.lease(job), path, size: Buffer.byteLength('verified test bytes'),
      sha256: createHash('sha256').update('verified test bytes').digest('hex'), contentType: 'text/markdown',
      scope: { visibility: 'private', teamId: null, agentIds: [] } };
    const artifact = await h.call('publishArtifact', publication, job.jobId);
    assert.equal((await h.call('publishArtifact', publication, job.jobId)).id, artifact.id);
    await rejectsCode(() => h.call('publishArtifact', { ...publication, contentType: 'text/plain' }, job.jobId), 'ARTIFACT_IMMUTABLE');
    await rejectsCode(() => h.call('publishArtifact', { ...publication, path: `${agent.id}/${job.jobId}/2/report.md` }, job.jobId), 'ARTIFACT_SCOPE_DENIED');
    await h.settle(job);
    await writeFile(join(directory, 'report.md'), 'tampered test bytes');
    const evidence = { artifactIds: [artifact.id], eventIds: [], taskId: job.taskId, jobId: job.jobId, summary: 'Persisted artifact fixture' };
    await rejectsCode(() => h.call('completeJob', { ...h.lease(job), outcome: { kind: 'run_task', evidence, summary: 'tampered', reply: null } }, job.jobId), 'ARTIFACT_INTEGRITY_MISMATCH');
  } finally { await h.close(); }
});

test('consultant completion pauses further work and proposes governed retirement', async () => {
  const h = await harness();
  try {
    await h.tx(async s => {
      const row = await s.get('agents', agent.id);
      await s.save('agents', { ...row, manifest: { ...row.manifest, agent: { ...row.manifest.agent, type: 'consultant' },
        consultant: { deliverable: 'one report', deadline: null, terminationCondition: 'One mission', knowledgeRecipientIds: [] } } });
    });
    await h.queue(); const job = await h.claim(); const evidence = await h.observe(job); await h.settle(job);
    await h.call('completeJob', { ...h.lease(job), outcome: { kind: 'run_task', evidence, summary: 'Bounded policy fixture', reply: null } }, job.jobId);
    const updated = await h.tx(s => s.get('agents', agent.id)); assert.equal(updated.status, 'PAUSED');
    const governance = await h.tx(s => s.list('governance'));
    assert.equal(governance[0]!.kind, 'retire'); assert.equal(governance[0]!.status, 'PENDING');
    assert.equal(governance[0]!.expectedVersion, updated.version);
  } finally { await h.close(); }
});

test('actual budget overrun remains durable and blocks further execution pending human governance', async () => {
  const h = await harness();
  try {
    await h.queue(); const job = await h.claim();
    const usage = await h.call('reserveBudget', { ...h.lease(job), modelCalls: 1, cost: 0.01, currency: 'USD' }, job.jobId);
    const settled = await h.call('settleBudget', { ...h.lease(job), reservationId: usage.id, modelCalls: 2, inputTokens: 100, outputTokens: 50, cost: 0.2 }, job.jobId);
    assert.equal(settled.cost, 0.2); assert.equal(settled.modelCalls, 2);
    const updated = await h.tx(s => s.get('agents', agent.id));
    assert.equal(updated.status, 'PAUSED'); assert.equal(updated.budgetExceeded, true);
    assert.equal((await h.tx(s => s.list('escalations')))[0]!.category, 'budget_overrun');
    await h.queue(); assert.equal(await h.claim(), null);
    const evidence = await h.observe(job);
    await rejectsCode(() => h.call('completeJob', { ...h.lease(job), outcome: { kind: 'run_task', evidence, summary: 'must not complete after overrun', reply: null } }, job.jobId), 'BUDGET_EXCEEDED');
    assert.equal((await h.tx(s => s.get('usage_reservations', usage.id))).cost, 0.2);
  } finally { await h.close(); }
});

test('message dispatch respects the pending task capacity and preserves blocked messages', async () => {
  const h = await harness();
  try {
    await h.tx(async s => {
      const row = await s.get('agents', agent.id);
      await s.save('agents', { ...row, manifest: { ...row.manifest, budget: { ...row.manifest.budget, maxConcurrentTasks: 1 } } });
      for (let i = 0; i < 3; i++) await s.insert('messages', { sender: hire.requestedBy, recipientId: agent.id, recipientKind: 'agent',
        content: `Pending source review ${i}`, actionable: true, inReplyTo: null, taskId: null, inputJobId: null,
        deliveryStatus: 'queued', blockedReason: null });
    });
    assert.ok(await h.claim()); assert.equal(await h.claim(), null);
    assert.equal((await h.tx(s => s.list('tasks'))).length, 1);
    const messages = await h.tx(s => s.list('messages'));
    assert.equal(messages.filter(m => m.deliveryStatus === 'blocked').length, 2);
    assert.equal(messages.filter(m => m.taskId).length, 1);
  } finally { await h.close(); }
});

test('human remediation retries exhausted retirement without changing its approved cleanup scope', async () => {
  const h = await harness();
  try {
    const human = { id: 'human-ceo', kind: 'human', organizationId: 'org-demo' };
    const lifecycle = (action: string, reason: string) => h.tx(async s => {
      const current = await s.get('agents', agent.id);
      return new Service(s, human, h.artifactRoot).lifecycle(agent.id, { action, reason, expectedVersion: current.version });
    });
    const retirement = await lifecycle('retire', 'Approved cleanup scope');
    const governance = retirement.governance;
    assert.ok(governance);
    await h.tx(s => new Service(s, human, h.artifactRoot).decideGovernance(governance.id,
      { expectedVersion: governance.version, decision: 'approve', reason: 'Review complete' }));
    let job = await h.claim('retire_agent');
    const original = job;
    await rejectsCode(() => lifecycle('remediate', 'Must not duplicate running cleanup'), 'RETIREMENT_IN_PROGRESS');
    for (let attempt = 1; attempt <= 3; attempt++) {
      assert.equal(job.attempt, attempt);
      await h.call('failJob', { ...h.lease(job), code: 'CLEANUP_UNAVAILABLE', message: 'Temporary cleanup failure', retryable: true, evidence: null }, job.jobId);
      if (attempt < 3) {
        assert.equal(await h.claim('retire_agent'), null);
        h.advance(5_001);
        job = await h.claim('retire_agent');
      }
    }
    assert.equal(await h.claim('retire_agent'), null);
    assert.equal((await h.tx(s => s.get('agents', agent.id))).status, 'TERMINATING');
    await h.tx(async s => {
      const current = await s.get('agents', agent.id);
      await rejectsCode(() => new Service(s, { ...human, id: agent.id, kind: 'agent' }, h.artifactRoot)
        .lifecycle(agent.id, { action: 'remediate', expectedVersion: current.version, reason: 'Agent cannot restart cleanup' }), 'HUMAN_APPROVAL_REQUIRED');
    });
    const retried = await lifecycle('remediate', 'Storage is available again');
    assert.equal(retried.agent.status, 'TERMINATING');
    assert.equal(retried.agent.cancellationRequested, true);
    await rejectsCode(() => lifecycle('remediate', 'Must not duplicate queued cleanup'), 'RETIREMENT_IN_PROGRESS');
    job = await h.claim('retire_agent');
    assert.notEqual(job.jobId, original.jobId);
    assert.equal(job.attempt, 1);
    assert.equal(job.payload.reason, 'Approved cleanup scope');
    assert.equal(job.hiringRequestId, original.hiringRequestId);
    await rejectsCode(() => h.call('appendJobEvent', { ...h.lease(original), type: 'cleanup.stale', message: 'Old attempt', data: {} }, original.jobId), 'STALE_LEASE');
    const evidence = await h.observe(job);
    await h.call('completeJob', { ...h.lease(job), outcome: { kind: 'retire_agent', evidence,
      credentialsRevoked: true, runtimeDisabled: true, knowledgePreserved: true, activeTasksResolved: true } }, job.jobId);
    assert.equal((await h.tx(s => s.get('agents', agent.id))).status, 'ARCHIVED');
    assert.equal((await h.tx(s => s.list('approvals'))).length, 1);
    assert.equal((await h.tx(s => s.list('jobs'))).filter(j => j.kind === 'retire_agent').length, 2);
    await rejectsCode(() => lifecycle('remediate', 'Archived agents cannot restart'), 'INVALID_TRANSITION');
  } finally { await h.close(); }
});

test('retirement remediation cannot turn an unapproved failed job into cleanup authority', async () => {
  const h = await harness('TERMINATING');
  try {
    await h.queue('retire_agent');
    const job = await h.claim('retire_agent');
    await h.call('failJob', { ...h.lease(job), code: 'CLEANUP_FAILED', message: 'Cleanup failed', retryable: false, evidence: null }, job.jobId);
    await rejectsCode(() => h.tx(async s => {
      const current = await s.get('agents', agent.id);
      return new Service(s, { id: 'human-ceo', kind: 'human', organizationId: 'org-demo' }, h.artifactRoot)
        .lifecycle(agent.id, { action: 'remediate', expectedVersion: current.version, reason: 'No approved retirement exists' });
    }), 'RETIREMENT_RETRY_UNAVAILABLE');
    assert.equal((await h.tx(s => s.list('jobs'))).length, 1);
  } finally { await h.close(); }
});

test('learning cannot claim another agent or another run canonical proposal', async () => {
  const h = await harness();
  try {
    await h.queue('learn');
    const job = await h.claim('learn');
    const evidence = await h.observe(job); await h.settle(job);
    const revision = await h.tx(s => s.insert('memory_entries', {
      ownerAgentId: agent.id, category: 'canonical', status: 'PROPOSED',
      provenance: { ...evidence, jobId: 'another-run' },
    }));
    const body = { ...h.lease(job), outcome: { kind: 'learn', learning: {
      summary: 'Grounded lesson', memoryIds: [], canonicalRevisionId: revision.id, evidence,
    } } };
    await rejectsCode(() => h.call('completeJob', body, job.jobId), 'MEMORY_FORBIDDEN');
    await h.tx(s => s.save('memory_entries', { ...revision, ownerAgentId: 'another-agent', provenance: evidence }));
    await rejectsCode(() => h.call('completeJob', body, job.jobId), 'MEMORY_FORBIDDEN');
  } finally { await h.close(); }
});
