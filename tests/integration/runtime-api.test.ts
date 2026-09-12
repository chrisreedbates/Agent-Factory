import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, seed } from '../../db/src/index.js';
import { proposal } from '../../packages/contracts/src/fixtures.js';
import { buildApp } from '../../apps/api/src/app.js';
import { ControlPlaneClient } from '../../apps/worker/src/client.js';
import { loadConfig } from '../../apps/worker/src/config.js';
import { JobRunner, JobLedger } from '../../apps/worker/src/handlers.js';
import { createLeaseGuard } from '../../apps/worker/src/runtime.js';
import { Workspace } from '../../apps/worker/src/workspace.js';
import { FakeModel } from '../../apps/worker/test/fakes.js';
const { PGlite } = createRequire(new URL('../../apps/api/package.json', import.meta.url))('@electric-sql/pglite');

// Deterministic model integration: all HTTP contracts, DB transitions, artifacts,
// fencing and recipient reads are real. This is explicitly NOT a live model demo.
test('actual API and runtime compile, provision, execute and propose governed learning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-runtime-api-'));
  let db: any;
  let closeDatabase: () => Promise<void>;
  if (process.env.TEST_DATABASE_URL) {
    const { Client } = createRequire(new URL('../../apps/api/package.json', import.meta.url))('pg');
    const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await client.connect();
    const schema = `runtime_${randomUUID().replaceAll('-', '')}`;
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    db = client;
    closeDatabase = async () => { try { await client.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await client.end(); } };
  } else {
    const pg = new PGlite();
    db = { async query<T>(sql: string, values?: unknown[]) {
      if (values?.length) return pg.query(sql, values);
      const results = await pg.exec(sql); return { rows: (results.at(-1)?.rows ?? []) as T[] };
    } };
    closeDatabase = () => pg.close();
  }
  await migrate(db); await seed(db);
  const operatorToken = 'operator-integration-token-123456789';
  const config = loadConfig({ WORKER_TOKEN: 'worker-integration-token-123456789', MODEL_NAME: 'test-model', ARTIFACT_ROOT: join(root, 'artifacts'), SOURCE_ROOT: join(root, 'sources') } as NodeJS.ProcessEnv);
  const app = buildApp({ db, operatorToken, workerToken: config.workerToken, artifactRoot: config.artifactRoot });
  let key = 0;
  const human = async (method: 'GET' | 'POST', url: string, body?: any) => {
    const result = await app.inject({ method, url, headers: { authorization: `Bearer ${operatorToken}`, 'idempotency-key': `integration-${++key}` }, ...(body ? { payload: body } : {}) });
    assert.equal(result.statusCode, 200, `${url}: ${result.body}`); return result.json().data;
  };
  const transport: typeof fetch = async (url, init) => {
    const result = await app.inject({ method: (init?.method ?? 'GET') as 'GET' | 'POST', url: new URL(String(url)).pathname + new URL(String(url)).search, headers: Object.fromEntries(new Headers(init?.headers).entries()), ...(init?.body ? { payload: String(init.body) } : {}) });
    return new Response(result.body, { status: result.statusCode, headers: { 'content-type': 'application/json' } });
  };
  const client = new ControlPlaneClient(config, transport);
  const model = new FakeModel(input => {
    if (input.system.includes('self-check')) return { content: String(input.messages.at(-1)?.content) };
    if (input.system.includes('compile') || input.system.includes('role designer')) return { content: JSON.stringify({ name: 'Research Lead', roleTitle: 'Research Lead', mission: proposal.mission, responsibilities: ['Check sources'], successMetrics: ['Verified claims'], standards: ['Cite sources'], evaluationCriteria: ['Every claim cited'], escalationTriggers: ['missing evidence'], learningCadence: 'daily' }) };
    if (input.system.includes('evidence-backed lesson')) return { content: JSON.stringify({ observation: 'Read the supplied brief.', hypothesis: 'Reading first grounds the result.', conclusion: 'Read sources before drafting.', title: 'Read first', canonicalRevision: { title: 'Source policy', content: 'Read approved sources before drafting.' } }) };
    if (input.system.includes('evaluate a provisioning run') || input.system.includes('evaluation gate')) {
      const payload = JSON.parse(String(input.messages.at(-1)?.content));
      return { content: JSON.stringify({ passed: true, deliverableMatches: true, objectiveAddressed: true, constraintsSatisfied: true, criteria: payload.criteria.map((criterion: string) => ({ criterion, passed: true, evidenceIds: [payload.evidence[0].id] })) }) };
    }
    const count = input.messages.filter(message => message.role === 'tool').length;
    if (count === 0) return { toolCalls: [{ id: 'read', name: 'read_file', arguments: { root: 'briefs', path: 'brief.md' } }] };
    if (count === 1) return { toolCalls: [{ id: 'write', name: 'write_file', arguments: { path: 'report.md', content: 'Approved source brief.md says test evidence exists.' } }] };
    return { content: JSON.stringify({ summary: 'Read brief.md and wrote a report.', reply: 'Report ready.', deliverable: 'report.md', escalation: { trigger: 'missing evidence', situation: 'One attachment was incomplete.', recommendation: 'Request source.' } }) };
  });
  const runner = new JobRunner({ config, client, workspace: new Workspace(config.artifactRoot, config.sourceRoot), model, log: () => {} });
  const run = async (kind: any) => {
    const job = await client.claim([kind], 60); assert.ok(job, `Missing ${kind}`);
    await runner.run(job, new JobLedger(client, job, config), createLeaseGuard(job));
  };
  try {
    const hire = await human('POST', '/v1/hiring-requests', { ...proposal, budget: { ...proposal.budget, modelCallsDaily: 100 } });
    await run('compile_manifest');
    const reviewed = await human('GET', `/v1/hiring-requests/${hire.id}`);
    await human('POST', `/v1/hiring-requests/${hire.id}/decision`, { decision: 'approve', expectedVersion: reviewed.version, manifestVersion: reviewed.manifestVersion, reason: 'Reviewed deterministic integration manifest.' });
    await mkdir(join(config.sourceRoot, hire.agentId), { recursive: true });
    await writeFile(join(config.sourceRoot, hire.agentId, 'brief.md'), 'Test evidence exists.');
    await run('provision_agent');
    assert.equal((await human('GET', `/v1/agents/${hire.agentId}`)).agent.status, 'ACTIVE');
    const escalations = await human('GET', '/v1/escalations');
    const probe = escalations.find((entry: any) => entry.category === 'provisioning_verification'); assert.ok(probe);
    await human('POST', `/v1/escalations/${probe.id}/resolve`, { expectedVersion: probe.version, resolution: 'Operator retrieved real provisioning probe.', followUp: null });
    const messages = await human('GET', '/v1/messages'); assert.ok(messages.some((entry: any) => entry.sender.id === hire.agentId));
    await human('POST', '/v1/tasks', { agentId: hire.agentId, objective: 'Read the approved brief.', constraints: ['Use the source'], deliverable: 'report.md', deadline: null });
    await run('run_task');
    // Provision a real report through the same worker; its durable probes must
    // be visible to the agent manager under an actual active task lease.
    const child = await human('POST', '/v1/hiring-requests', { ...proposal, role: 'Evidence Analyst', proposedManagerId: hire.agentId, proposedManagerKind: 'agent', budget: { ...proposal.budget, modelCallsDaily: 100 } });
    await run('compile_manifest');
    const childReview = await human('GET', `/v1/hiring-requests/${child.id}`);
    await human('POST', `/v1/hiring-requests/${child.id}/decision`, { decision: 'approve', expectedVersion: childReview.version, manifestVersion: childReview.manifestVersion, reason: 'Reviewed report manifest.' });
    await mkdir(join(config.sourceRoot, child.agentId), { recursive: true });
    await writeFile(join(config.sourceRoot, child.agentId, 'brief.md'), 'Test evidence exists.');
    await run('provision_agent');
    await human('POST', '/v1/tasks', { agentId: hire.agentId, objective: 'Retrieve the report verification.', constraints: [], deliverable: 'report.md', deadline: null });
    const managerJob = await client.claim(['run_task'], 60); assert.ok(managerJob);
    const delegatedGet = async (path: string) => {
      const response = await app.inject({ method: 'GET', url: path, headers: { authorization: `Bearer ${config.workerToken}`, 'x-job-id': managerJob.jobId, 'x-lease-token': managerJob.leaseToken, 'x-job-attempt': String(managerJob.attempt) } });
      assert.equal(response.statusCode, 200, response.body); return response.json().data;
    };
    const received = await delegatedGet('/v1/messages');
    assert.ok(received.some((entry: any) => entry.sender.id === child.agentId && entry.recipientId === hire.agentId));
    const reportProbe = (await delegatedGet('/v1/escalations')).find((entry: any) => entry.agentId === child.agentId && entry.category === 'provisioning_verification'); assert.ok(reportProbe);
    await assert.rejects(client.asAgent(managerJob, 'resolveEscalation', `/v1/escalations/${reportProbe.id}/resolve`, { expectedVersion: reportProbe.version, resolution: 'Unauthorized manager approval', followUp: null }));
    await human('POST', `/v1/escalations/${reportProbe.id}/resolve`, { expectedVersion: reportProbe.version, resolution: 'Human resolved report probe.', followUp: null });
    assert.equal((await delegatedGet('/v1/escalations')).find((entry: any) => entry.id === reportProbe.id).status, 'RESOLVED');
    await runner.run(managerJob, new JobLedger(client, managerJob, config), createLeaseGuard(managerJob));
    const unrelated = await human('POST', '/v1/hiring-requests', { ...proposal, role: 'Unrelated reviewer', mission: 'Independent scope boundary test.' });
    await human('POST', '/v1/tasks', { agentId: child.agentId, objective: 'Verify communication boundary.', constraints: [], deliverable: 'report.md', deadline: null });
    const childJob = await client.claim(['run_task'], 60); assert.ok(childJob);
    await assert.rejects(client.asAgent(childJob, 'createMessage', '/v1/messages', { recipientId: unrelated.agentId, recipientKind: 'agent', content: 'Forbidden peer message', actionable: false, inReplyTo: null, taskId: childJob.taskId }), (error: any) => error.code === 'COMMUNICATION_FORBIDDEN');
    await runner.run(childJob, new JobLedger(client, childJob, config), createLeaseGuard(childJob));
    await human('POST', '/v1/schedules', { agentId: hire.agentId, kind: 'learn', intervalSeconds: 3600, nextRunAt: new Date(Date.now() - 1000).toISOString(), payload: {} });
    await run('learn');
    const lessons = await human('GET', '/v1/learning'); assert.equal(lessons.length, 1); assert.ok(lessons[0].canonicalRevisionId);
    const memories = await human('GET', '/v1/memory');
    assert.equal(memories.find((entry: any) => entry.id === lessons[0].canonicalRevisionId).status, 'PROPOSED');
    const governance = await human('GET', '/v1/governance');
    const approval = governance.find((entry: any) => entry.kind === 'canonical_revision' && entry.status === 'PENDING'); assert.ok(approval);
    await human('POST', `/v1/governance/${approval.id}/decision`, { decision: 'approve', expectedVersion: approval.version, reason: 'Human reviewed exact grounded policy.' });
    const approvedMemory = await human('GET', '/v1/memory');
    assert.equal(approvedMemory.find((entry: any) => entry.id === lessons[0].canonicalRevisionId).status, 'ACTIVE');
  } finally { await app.close(); await closeDatabase(); await rm(root, { recursive: true, force: true }); }
});
