import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentManifest, validateResponse } from '@agent-factory/contracts';
import { loadConfig } from '../src/config.js';
import { JobLedger, JobRunner } from '../src/handlers.js';
import { LeaseLostError } from '../src/errors.js';
import { REQUIRED_VERIFICATION_CHECKS } from '../src/evidence.js';
import { WorkerRuntime } from '../src/runtime.js';
import type { ModelAdapter } from '../src/model.js';
import type { ClaimedJob } from '../src/types.js';
import { FakeControlPlane, FakeModel, UnavailableModel, makeAgent, makeJob, makeManifest } from './fakes.js';
import { Workspace } from '../src/workspace.js';

async function makeRig(model: ModelAdapter) {
  const root = await mkdtemp(join(tmpdir(), 'af-worker-rig-'));
  // Briefs are scoped per agent, mirroring the production workspace layout.
  const briefs = join(root, 'sources', 'agent-1');
  await mkdir(briefs, { recursive: true });
  await writeFile(join(briefs, 'brief.md'), '# Brief\nGround truth about the market.');
  const config = loadConfig({
    WORKER_TOKEN: 't'.repeat(32),
    MODEL_NAME: 'test-model',
    ARTIFACT_ROOT: join(root, 'artifacts'),
    SOURCE_ROOT: join(root, 'sources'),
  } as NodeJS.ProcessEnv);
  const client = new FakeControlPlane();
  const workspace = new Workspace(config.artifactRoot, config.sourceRoot);
  const runner = new JobRunner({ config, client, workspace, model, log: () => {} });
  const runtime = new WorkerRuntime({ config, client, runner, log: () => {}, enableRenewal: false });
  return { config, client, workspace, runner, runtime, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function runJob(rig: Awaited<ReturnType<typeof makeRig>>, job: ClaimedJob): Promise<void> {
  await rig.runner.run(job, new JobLedger(rig.client, job, rig.config), guardFor(job));
}

function guardFor(job: ClaimedJob) {
  // A live guard for direct runner tests; lease-loss behaviour is covered separately.
  return {
    signal: new AbortController().signal,
    lost: false,
    assertLive: () => {},
    update: () => {},
    lose: () => {},
  };
}

/** Drives a tool loop: read the brief, write a deliverable, then return the final JSON object. */
function agentLoopModel(final: Record<string, unknown>, deliverable: string, content = '# Report\nGrounded in brief.md.') {
  return new FakeModel(input => {
    const toolResults = input.messages.filter(message => message.role === 'tool').length;
    if (toolResults === 0) return { toolCalls: [{ id: 'call-read', name: 'read_file', arguments: { root: 'briefs', path: 'brief.md' } }] };
    if (toolResults === 1) return { toolCalls: [{ id: 'call-write', name: 'write_file', arguments: { path: deliverable, content } }] };
    return { content: JSON.stringify(final) };
  });
}

test('run_task reads a source, writes a deliverable, verifies read-back and settles before completing', async () => {
  const model = agentLoopModel({ summary: 'Wrote the cited report.', reply: 'The report is ready.', deliverable: 'report.md' }, 'report.md');
  const rig = await makeRig(model);
  try {
    const job = makeJob('run_task', {
      agent: makeAgent(),
      task: { id: 'task-1', objective: 'Write a cited report', constraints: [], deliverable: 'report.md', deadline: null },
      inputMessage: { id: 'msg-1', sender: { id: 'human-ceo', kind: 'human' }, content: 'Please produce the report.' },
    }, { taskId: 'task-1', inputMessageId: 'msg-1' });

    await runJob(rig, job);

    assert.equal(rig.client.failed.length, 0, JSON.stringify(rig.client.failed));
    const outcome = rig.client.completed.at(-1)!.outcome as any;
    assert.equal(outcome.kind, 'run_task');
    assert.ok(outcome.evidence.artifactIds.length >= 2, 'the deliverable and validation record are published');
    assert.equal(outcome.summary, 'Wrote the cited report.');
    assert.equal(outcome.reply, 'The report is ready.');
    assert.ok(rig.client.ops.indexOf('settleBudget') < rig.client.ops.indexOf('completeJob'));
    // The model had to read a source before writing.
    assert.equal(model.calls.length, 3);
    assert.ok(model.calls[1].messages.some(message => message.role === 'tool'));
    for (const artifact of rig.client.artifacts) assert.match(artifact.path, /^agent-1\/job-run_task\/1\//);
  } finally {
    await rig.cleanup();
  }
});

test('an undeclared tool call is denied and the attempt cannot claim a deliverable', async () => {
  const manifest = makeManifest({
    tools: ['workspace-files'],
    permissions: [{ tool: 'workspace-files', operations: ['read'], resource: null, credentialRef: null }],
  });
  const model = new FakeModel([
    { toolCalls: [{ id: 'call-write', name: 'write_file', arguments: { path: 'sneaky.md', content: 'should not be written' } }] },
    { content: JSON.stringify({ summary: 'Claimed to write a file.', reply: 'done', deliverable: 'sneaky.md' }) },
  ]);
  const rig = await makeRig(model);
  try {
    const job = makeJob('run_task', {
      agent: makeAgent({ manifest }),
      task: { id: 'task-1', objective: 'Try an undeclared write', constraints: [], deliverable: 'sneaky.md', deadline: null },
      inputMessage: null,
    }, { taskId: 'task-1' });
    rig.client.queue.push(job);

    assert.equal(await rig.runtime.runOnce(), true);
    assert.equal(rig.client.completed.length, 0);
    assert.equal(rig.client.failed.at(-1)!.code, 'DELIVERABLE_MISSING');
    assert.equal(rig.client.artifacts.length, 0, 'no artifact may be published for an undeclared tool');
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

test('compilation fails on unsupported requested tools instead of silently dropping them', async () => {
  const draft = { name: 'Sales Agent', roleTitle: 'Sales Agent', mission: 'Sell.', responsibilities: ['Sell'], successMetrics: ['Revenue'], standards: ['Be honest'], evaluationCriteria: ['Revenue cited'], escalationTriggers: ['missing evidence'], learningCadence: 'daily' };
  const rig = await makeRig(new FakeModel([{ content: JSON.stringify(draft) }]));
  try {
    const job = makeJob('compile_manifest', {
      hiringRequest: {
        proposal: {
          role: 'Sales Agent', mission: 'Sell', justification: 'Need sales', expectedBenefit: 'Revenue',
          agentType: 'employee', teamId: 'team-research', proposedManagerId: 'human-ceo', proposedManagerKind: 'human',
          responsibilities: ['Sell'], tools: ['salesforce'],
          grants: [{ tool: 'salesforce', operations: ['read'], resource: null, credentialRef: null }],
          budget: { modelCallsDaily: 20, externalSpendDaily: 5, currency: 'USD', maxConcurrentTasks: 2 },
        },
      },
      agent: { id: 'agent-2', organizationId: 'org-demo' },
      organization: { id: 'org-demo', mission: 'Build.' },
      teams: [{ id: 'team-research', mission: 'Research.' }],
    }, { agentId: 'agent-2' });
    rig.client.queue.push(job);

    assert.equal(await rig.runtime.runOnce(), true);
    assert.equal(rig.client.completed.length, 0);
    assert.equal(rig.client.failed.at(-1)!.code, 'TOOL_UNAVAILABLE');
  } finally {
    await rig.cleanup();
  }
});

test('provisioning runs a real verified workflow and emits every mandatory check', async () => {
  const model = new FakeModel(input => {
    if (input.system.includes('self-check')) {
      const last = input.messages.at(-1);
      return { content: last && last.role === 'user' ? last.content : '' };
    }
    const toolResults = input.messages.filter(message => message.role === 'tool').length;
    if (toolResults === 0) return { toolCalls: [{ id: 'call-read', name: 'read_file', arguments: { root: 'briefs', path: 'brief.md' } }] };
    if (toolResults === 1) return { toolCalls: [{ id: 'call-write', name: 'write_file', arguments: { path: 'provision-report.md', content: '# Provisioning report\nGrounded in brief.md.' } }] };
    return { content: JSON.stringify({
      summary: 'Read the brief and wrote the report.',
      reply: 'Provisioning verification complete.',
      deliverable: 'provision-report.md',
      escalation: { trigger: 'missing evidence', situation: 'One brief was incomplete.', recommendation: 'Request the missing source.' },
    }) };
  });
  const rig = await makeRig(model);
  try {
    const job = makeJob('provision_agent', { agent: makeAgent({ status: 'PROVISIONING' }), manifest: makeManifest(), manifestVersion: 1 });
    await runJob(rig, job);

    const outcome = rig.client.completed.at(-1)!.outcome as any;
    assert.equal(outcome.kind, 'provision_agent', JSON.stringify(rig.client.failed));
    const names = outcome.checks.map((check: any) => check.name);
    for (const required of REQUIRED_VERIFICATION_CHECKS) assert.ok(names.includes(required), `missing verification: ${required}`);
    assert.ok(outcome.checks.every((check: any) => check.passed && check.error === null));
    assert.ok(outcome.steps.length >= outcome.checks.length);
    const resourceTypes = outcome.resources.map((resource: any) => resource.type);
    assert.ok(resourceTypes.includes('workspace'));
    assert.ok(resourceTypes.includes('runtime'));
    assert.ok(rig.client.ops.indexOf('settleBudget') < rig.client.ops.indexOf('completeJob'));
    assert.ok(rig.client.ops.includes('probeUnauthorized'), 'authentication is a real boundary probe');
  } finally {
    await rig.cleanup();
  }
});

test('renewal loss aborts the active attempt without further spend or a reported outcome', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-worker-renew-'));
  try {
    const config = loadConfig({
      WORKER_TOKEN: 't'.repeat(32), MODEL_NAME: 'test-model',
      ARTIFACT_ROOT: join(root, 'artifacts'), SOURCE_ROOT: join(root, 'sources'),
    } as NodeJS.ProcessEnv);
    const client = new FakeControlPlane();
    client.renewError = new LeaseLostError(409, 'fenced by a newer attempt');
    const model = new FakeModel([{ content: JSON.stringify({ name: 'X', roleTitle: 'X', mission: 'X', responsibilities: ['x'], successMetrics: ['x'], standards: ['x'], evaluationCriteria: ['x'], escalationTriggers: ['x'], learningCadence: 'daily' }) }], { delayMs: 60 });
    const workspace = new Workspace(config.artifactRoot, config.sourceRoot);
    const runner = new JobRunner({ config, client, workspace, model, log: () => {} });
    const runtime = new WorkerRuntime({ config, client, runner, log: () => {}, enableRenewal: true, renewIntervalMs: 5 });
    client.queue.push(makeJob('compile_manifest', {
      hiringRequest: { proposal: { role: 'X', mission: 'Y', tools: [], grants: [], budget: { currency: 'USD' } } },
      agent: { id: 'agent-2', organizationId: 'org-demo' },
      organization: { mission: 'm' }, teams: [],
    }, { agentId: 'agent-2' }));

    assert.equal(await runtime.runOnce(), true);
    assert.equal(client.completed.length, 0, 'a lost attempt must not complete');
    assert.equal(client.failed.length, 0, 'a lost lease is abandoned, not reported as a job failure');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('learn grounds the lesson in prior persisted evidence and never self-references', async () => {
  const model = new FakeModel([{
    content: JSON.stringify({
      observation: 'Prior scope check found a missing attachment.', hypothesis: 'Validate attachments first.',
      conclusion: 'Check attachments before drafting.', title: 'Validate inputs', content: 'Always verify source availability.',
    }),
  }]);
  const rig = await makeRig(model);
  try {
    rig.client.memoryEntries = [{ id: 'memory-prior', title: 'Prior lesson', content: 'Prior content', provenance: { artifactIds: ['artifact-prior'], eventIds: [], taskId: null, jobId: null, summary: 'prior' } }];
    await runJob(rig, makeJob('learn', { agent: makeAgent() }));

    const outcome = rig.client.completed.at(-1)!.outcome as any;
    assert.equal(outcome.kind, 'learn');
    assert.equal(rig.client.memories.length, 1);
    assert.deepEqual(rig.client.memories[0].provenance.artifactIds, ['artifact-prior'], 'memory provenance must reference prior evidence');
    assert.deepEqual(outcome.learning.memoryIds, [rig.client.memories[0].id]);
  } finally {
    await rig.cleanup();
  }
});

test('learn fails rather than manufacturing a lesson when no prior evidence exists', async () => {
  const rig = await makeRig(new FakeModel([{ content: '{}' }]));
  try {
    rig.client.queue.push(makeJob('learn', { agent: makeAgent() }));
    assert.equal(await rig.runtime.runOnce(), true);
    assert.equal(rig.client.completed.length, 0);
    assert.equal(rig.client.failed.at(-1)!.code, 'NO_PRIOR_EVIDENCE');
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
