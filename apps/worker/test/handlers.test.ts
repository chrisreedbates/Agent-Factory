import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentManifest, validateResponse } from '@agent-factory/contracts';
import { loadConfig } from '../src/config.js';
import { JobLedger, JobRunner } from '../src/handlers.js';
import { REQUIRED_VERIFICATION_CHECKS } from '../src/evidence.js';
import { WorkerRuntime } from '../src/runtime.js';
import type { ModelAdapter } from '../src/model.js';
import type { ClaimedJob } from '../src/types.js';
import { FakeControlPlane, FakeModel, UnavailableModel, makeAgent, makeJob, makeManifest } from './fakes.js';
import { Workspace } from '../src/workspace.js';

async function makeRig(model: ModelAdapter) {
  const root = await mkdtemp(join(tmpdir(), 'af-worker-rig-'));
  const sources = join(root, 'sources');
  await mkdir(sources, { recursive: true });
  await writeFile(join(sources, 'brief.md'), '# Brief\nGround truth about the market.');
  const config = loadConfig({
    WORKER_TOKEN: 't'.repeat(32),
    MODEL_NAME: 'test-model',
    ARTIFACT_ROOT: join(root, 'artifacts'),
    SOURCE_ROOT: sources,
  } as NodeJS.ProcessEnv);
  const client = new FakeControlPlane();
  const workspace = new Workspace(config.artifactRoot, config.sourceRoot);
  const runner = new JobRunner({ config, client, workspace, model, log: () => {} });
  const runtime = new WorkerRuntime({ config, client, runner, log: () => {}, enableRenewal: false });
  return { config, client, workspace, runner, runtime, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function runJob(rig: Awaited<ReturnType<typeof makeRig>>, job: ClaimedJob): Promise<void> {
  await rig.runner.run(job, new JobLedger(rig.client, job, rig.config));
}

test('run_task executes the tool loop, publishes real artifacts and settles before completing', async () => {
  const model = new FakeModel([
    { toolCalls: [{ id: 'call-1', name: 'write_file', arguments: { path: 'report.md', content: '# Report\nGrounded in the brief.' } }] },
    { content: JSON.stringify({ summary: 'Wrote the cited report.', reply: 'The report is ready.' }) },
  ]);
  const rig = await makeRig(model);
  try {
    const job = makeJob('run_task', {
      agent: makeAgent(),
      task: { id: 'task-1', objective: 'Write a cited report', constraints: [], deliverable: 'report.md', deadline: null },
      inputMessage: { id: 'msg-1', sender: { id: 'human-ceo', kind: 'human' }, content: 'Please produce the report.' },
    }, { taskId: 'task-1', inputMessageId: 'msg-1' });

    await runJob(rig, job);

    assert.equal(rig.client.failed.length, 0);
    const outcome = rig.client.completed.at(-1)!.outcome as any;
    assert.equal(outcome.kind, 'run_task');
    assert.ok(outcome.evidence.artifactIds.length >= 2, 'the written deliverable and the final result are published');
    assert.match(outcome.summary, /report/i);
    assert.equal(outcome.reply, 'The report is ready.');
    assert.ok(rig.client.ops.indexOf('settleBudget') < rig.client.ops.indexOf('completeJob'), 'usage must settle before completion');
    // The model genuinely received the tool result before its final turn.
    assert.equal(model.calls.length, 2);
    assert.ok(model.calls[1].messages.some(message => message.role === 'tool'));
    for (const artifact of rig.client.artifacts) assert.match(artifact.path, /^agent-1\/job-run_task\/1\//);
  } finally {
    await rig.cleanup();
  }
});

test('compile_manifest validates the assembled manifest against the shared contract', async () => {
  const draft = {
    name: 'Evidence Analyst', roleTitle: 'Evidence Analyst', mission: 'Verify evidence.',
    responsibilities: ['Check sources'], successMetrics: ['Verified claims'], standards: ['Cite sources'],
    evaluationCriteria: ['Every claim cited'], escalationTriggers: ['missing evidence'], learningCadence: 'daily',
  };
  const rig = await makeRig(new FakeModel([{ content: JSON.stringify(draft) }]));
  try {
    const job = makeJob('compile_manifest', {
      hiringRequest: {
        proposal: {
          role: 'Evidence Analyst', mission: 'Verify evidence', justification: 'Need verification', expectedBenefit: 'Trustworthy output',
          agentType: 'employee', teamId: 'team-research', proposedManagerId: 'human-ceo', proposedManagerKind: 'human',
          responsibilities: ['Verify'], tools: ['workspace-files'],
          grants: [{ tool: 'workspace-files', operations: ['read', 'write', 'list'], resource: null, credentialRef: null }],
          budget: { modelCallsDaily: 20, externalSpendDaily: 5, currency: 'USD', maxConcurrentTasks: 2 },
        },
      },
      agent: { id: 'agent-2', organizationId: 'org-demo' },
      organization: { id: 'org-demo', mission: 'Build a reliable organization.' },
      teams: [{ id: 'team-research', mission: 'Produce verifiable research.' }],
    }, { agentId: 'agent-2' });

    await runJob(rig, job);

    const outcome = rig.client.completed.at(-1)!.outcome as any;
    assert.equal(outcome.kind, 'compile_manifest');
    assert.ok(validateResponse(AgentManifest, outcome.manifest), JSON.stringify(outcome.manifest));
    assert.equal(outcome.manifest.agent.id, 'agent-2');
    assert.equal(outcome.manifest.runtime.model, 'test-model');
    assert.deepEqual(outcome.manifest.organization.reports, []);
  } finally {
    await rig.cleanup();
  }
});

test('provisioning emits every mandatory verification check with persisted evidence', async () => {
  const rig = await makeRig(new FakeModel([{ content: 'READY' }]));
  try {
    const job = makeJob('provision_agent', { agent: makeAgent({ status: 'PROVISIONING' }), manifest: makeManifest(), manifestVersion: 1 });
    await runJob(rig, job);

    const outcome = rig.client.completed.at(-1)!.outcome as any;
    assert.equal(outcome.kind, 'provision_agent');
    const names = outcome.checks.map((check: any) => check.name);
    for (const required of REQUIRED_VERIFICATION_CHECKS) assert.ok(names.includes(required), `missing verification: ${required}`);
    assert.ok(outcome.checks.every((check: any) => check.passed && check.error === null));
    assert.ok(outcome.steps.length >= outcome.checks.length);
    const resourceTypes = outcome.resources.map((resource: any) => resource.type);
    assert.ok(resourceTypes.includes('workspace'));
    assert.ok(resourceTypes.includes('runtime'));
    assert.ok(rig.client.ops.indexOf('settleBudget') < rig.client.ops.indexOf('completeJob'));
  } finally {
    await rig.cleanup();
  }
});

test('learn persists the lesson and links the agent-owned memory entry', async () => {
  const model = new FakeModel([{
    content: JSON.stringify({
      observation: 'Sources were missing.', hypothesis: 'Validate attachments first.',
      conclusion: 'Check attachments before drafting.', title: 'Validate inputs', content: 'Always verify source availability.',
    }),
  }]);
  const rig = await makeRig(model);
  try {
    const job = makeJob('learn', { agent: makeAgent() });
    await runJob(rig, job);

    const outcome = rig.client.completed.at(-1)!.outcome as any;
    assert.equal(outcome.kind, 'learn');
    assert.equal(rig.client.memories.length, 1);
    assert.deepEqual(outcome.learning.memoryIds, [rig.client.memories[0].id]);
    assert.equal(rig.client.memories[0].ownerAgentId, 'agent-1');
  } finally {
    await rig.cleanup();
  }
});

test('retirement reports only cleanup facts it can verify', async () => {
  const rig = await makeRig(new FakeModel([]));
  try {
    const job = makeJob('retire_agent', { agent: makeAgent({ status: 'TERMINATING' }), reason: 'Mission complete.' });
    await runJob(rig, job);

    const outcome = rig.client.completed.at(-1)!.outcome as any;
    assert.equal(outcome.kind, 'retire_agent');
    assert.equal(outcome.runtimeDisabled, true);
    assert.equal(outcome.knowledgePreserved, true);
    assert.equal(outcome.credentialsRevoked, true);
    assert.ok(outcome.evidence.artifactIds.length >= 1);
  } finally {
    await rig.cleanup();
  }
});

test('a missing real model fails the job instead of reporting simulated success', async () => {
  const rig = await makeRig(new UnavailableModel());
  try {
    const job = makeJob('compile_manifest', {
      hiringRequest: { proposal: { role: 'X', mission: 'Y', tools: [], grants: [], budget: { currency: 'USD' } } },
      agent: { id: 'agent-2', organizationId: 'org-demo' },
      organization: { mission: 'm' },
      teams: [],
    }, { agentId: 'agent-2' });
    rig.client.queue.push(job);

    assert.equal(await rig.runtime.runOnce(), true);
    assert.equal(rig.client.completed.length, 0);
    const failure = rig.client.failed.at(-1)!;
    assert.equal(failure.code, 'MODEL_UNAVAILABLE');
    assert.equal(failure.retryable, false);
  } finally {
    await rig.cleanup();
  }
});

test('runOnce reports no work when nothing is queued', async () => {
  const rig = await makeRig(new FakeModel([]));
  try {
    assert.equal(await rig.runtime.runOnce(), false);
  } finally {
    await rig.cleanup();
  }
});
