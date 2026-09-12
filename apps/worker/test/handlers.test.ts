import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentManifest, validateResponse } from '@agent-factory/contracts';
import { loadConfig } from '../src/config.js';
import { JobLedger, JobRunner } from '../src/handlers.js';
import { LeaseLostError, WorkerError } from '../src/errors.js';
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
    if (input.system.includes('evaluation gate')) {
      const payload = JSON.parse(String(input.messages.at(-1)?.content ?? '{}')) as { criteria?: string[]; evidence?: { id: string }[] };
      const evidenceId = (payload.evidence ?? [{ id: 'missing' }])[0]!.id;
      return { content: JSON.stringify({ passed: true, deliverableMatches: true, objectiveAddressed: true, constraintsSatisfied: true, criteria: (payload.criteria ?? []).map(criterion => ({ criterion, passed: true, evidenceIds: [evidenceId] })) }) };
    }
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
    // The model had to read a source before writing, then the evaluation gate ran.
    assert.equal(model.calls.length, 4);
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

/** Drives the provisioning run: nonce self-check, brief read, deliverable, then a reply and escalation. */
function provisioningModel() {
  return new FakeModel(input => {
    if (input.system.includes('self-check')) {
      const last = input.messages.at(-1);
      return { content: last && last.role === 'user' ? last.content : '' };
    }
    if (input.system.includes('evaluate a provisioning run')) {
      const payload = JSON.parse(String(input.messages.at(-1)?.content ?? '{}')) as { criteria?: string[]; evidence?: { id: string }[] };
      const evidenceId = (payload.evidence ?? [{ id: 'missing' }])[0]!.id;
      return { content: JSON.stringify({ passed: true, criteria: (payload.criteria ?? []).map(criterion => ({ criterion, passed: true, evidenceIds: [evidenceId] })) }) };
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
}

test('provisioning allows sequential discovery, read, write and final response within its configured bound', async () => {
  const base = provisioningModel();
  const model: ModelAdapter = { name: base.name, turn: async input => {
    if (!input.system.includes('self-check') && !input.system.includes('evaluate a provisioning run') && !input.messages.some(message => message.role === 'tool')) {
      return { content: null, usage: { modelCalls: 1, inputTokens: 1, outputTokens: 1, cost: null }, toolCalls: [{ id: 'discover', name: 'list_files', arguments: { root: 'briefs' } }] };
    }
    return base.turn({ ...input, messages: input.messages.filter(message => message.role !== 'tool' || message.toolCallId !== 'discover') });
  } };
  const rig = await makeRig(model);
  try {
    await runJob(rig, makeJob('provision_agent', { agent: makeAgent({ status: 'PROVISIONING' }), manifest: makeManifest(), manifestVersion: 1 }));
    assert.equal(rig.client.completed.at(-1)!.outcome.kind, 'provision_agent');
    assert.ok(rig.client.events.some(event => event.data?.operation === 'list'));
  } finally { await rig.cleanup(); }
});

test('provisioning can list and read back its immutable outputs without exposing other attempts', async () => {
  const base = provisioningModel();
  const extraIds = new Set(['read-storage-path', 'read-write-name', 'list-output', 'read-other-agent']);
  const model: ModelAdapter = { name: base.name, turn: async input => {
    if (input.system.includes('self-check') || input.system.includes('evaluate a provisioning run')) return base.turn(input);
    const results = input.messages.filter(message => message.role === 'tool');
    const tool = (id: string, name: string, args: Record<string, unknown>) => ({
      content: null, usage: { modelCalls: 1, inputTokens: 1, outputTokens: 1, cost: null },
      toolCalls: [{ id, name, arguments: args }],
    });
    if (results.length === 2) {
      const storagePath = /^wrote (\S+)/.exec(results[1]!.content)![1]!;
      return tool('read-storage-path', 'read_file', { root: 'workspace', path: storagePath });
    }
    if (results.length === 3) {
      assert.equal(results[2]!.content, '# Provisioning report\nGrounded in brief.md.');
      return tool('read-write-name', 'read_file', { root: 'workspace', path: 'provision-report.md' });
    }
    if (results.length === 4) {
      assert.equal(results[3]!.content, results[2]!.content);
      return tool('list-output', 'list_files', { root: 'workspace' });
    }
    if (results.length === 5) {
      assert.ok(JSON.parse(results[4]!.content).some((file: { path: string }) => file.path === 'provision-report.md'));
      return tool('read-other-agent', 'read_file', { root: 'workspace', path: 'agent-other/job-other/1/secret.md' });
    }
    if (results.length === 6) assert.match(results[5]!.content, /^tool error:/);
    return base.turn({ ...input, messages: input.messages.filter(message => message.role !== 'tool' || !extraIds.has(message.toolCallId)) });
  } };
  const rig = await makeRig(model);
  try {
    await rig.workspace.writeArtifact('agent-other', 'job-other', 1, 'secret.md', 'Private sibling data');
    await runJob(rig, makeJob('provision_agent', { agent: makeAgent({ status: 'PROVISIONING' }), manifest: makeManifest(), manifestVersion: 1 }));
    assert.equal(rig.client.completed.at(-1)!.outcome.kind, 'provision_agent');
    const event = rig.client.events.find(event => event.type === 'verification.end_to_end');
    assert.equal(event?.data?.briefsRead, 1, 'artifact readback must not count as reading a source brief');
  } finally { await rig.cleanup(); }
});

test('provisioning activates through the dedicated fenced communication capability, never delegated sends', async () => {
  const rig = await makeRig(provisioningModel());
  try {
    const job = makeJob('provision_agent', { agent: makeAgent({ status: 'PROVISIONING' }), manifest: makeManifest(), manifestVersion: 1 });
    rig.client.queue.push(job);
    assert.equal(await rig.runtime.runOnce(), true);

    // The dedicated 1.1.0 capability is the only route used; the forbidden
    // pre-ACTIVE delegation path is never attempted.
    assert.equal(rig.client.provisioningCommunications.length, 1, 'the fenced capability must be exercised exactly once');
    assert.ok(!rig.client.ops.includes('createMessage'), 'provisioning must not attempt delegated messaging');
    assert.ok(!rig.client.ops.includes('createEscalation'), 'provisioning must not attempt delegated escalation');
    assert.ok(rig.client.ops.includes('probeUnauthorized'), 'authentication is still a real boundary probe');
    const { messageId, escalationId } = rig.client.provisioningCommunications[0]!;

    // Every mandatory check now reports PASSED with evidence, so activation can proceed.
    assert.equal(rig.client.failed.length, 0);
    const outcome = rig.client.completed.at(-1)!.outcome as any;
    assert.equal(outcome.kind, 'provision_agent');
    const check = (name: string) => outcome.checks.find((candidate: any) => candidate.name === name);
    for (const required of REQUIRED_VERIFICATION_CHECKS) {
      assert.ok(check(required)?.passed && check(required)?.evidence, `missing verification: ${required}`);
    }

    // The communication and escalation evidence cites the server-returned ids.
    const eventIds = new Set(rig.client.events.map(event => event.id));
    for (const name of ['communication', 'escalation']) {
      const cited = check(name).evidence.eventIds as string[];
      assert.ok(cited.length > 0 && cited.every(id => eventIds.has(id)), `${name} must cite persisted attempts events`);
    }
    assert.equal((rig.client.events.find(event => event.type === 'verification.communication')!.data as any).messageId, messageId);
    assert.equal((rig.client.events.find(event => event.type === 'verification.escalation')!.data as any).escalationId, escalationId);

    // The restart check is a real reinitialization: a fresh process recovers both
    // the persisted artifact and the agent's working memory.
    const restart = rig.client.events.find(event => event.type === 'verification.restart')!;
    assert.equal((restart.data as any).memoryPath, 'memory/working.json');
    const restartArtifact = rig.client.artifacts.find(artifact => artifact.path.endsWith('restart-check.json'))!;
    const restartCheck = JSON.parse(await readFile(rig.workspace.absoluteArtifactPath(restartArtifact.path), 'utf8')) as any;
    const memoryOnDisk = await rig.workspace.read('workspace', 'agent-1', 'memory/working.json');
    assert.equal(restartCheck.memory.sha256, createHash('sha256').update(memoryOnDisk).digest('hex'));
    assert.equal(restartCheck.memory.sha256, (restart.data as any).memorySha256);
  } finally {
    await rig.cleanup();
  }
});

test('provisioning fails closed when the control plane does not support the verification capability', async () => {
  const rig = await makeRig(provisioningModel());
  try {
    // An unimplemented capability (404/405) is the only deferrable refusal: the
    // checks stay blocked instead of failing the whole attempt.
    rig.client.provisionCommunicationError = new WorkerError('NOT_FOUND', 'Unknown worker operation', false);
    const job = makeJob('provision_agent', { agent: makeAgent({ status: 'PROVISIONING' }), manifest: makeManifest(), manifestVersion: 1 });
    rig.client.queue.push(job);
    assert.equal(await rig.runtime.runOnce(), true);

    // A refusal is never reported as activation, and nothing is fabricated.
    assert.equal(rig.client.completed.length, 0, 'a refusal must not report activation');
    assert.equal(rig.client.failed.at(-1)!.code, 'VERIFICATION_BLOCKED');
    assert.equal(rig.client.provisioningCommunications.length, 0);

    // A diagnostic records every check, including exactly the blocked ones.
    const diagnostic = rig.client.artifacts.find(artifact => artifact.path.endsWith('provisioning-verification.json'));
    assert.ok(diagnostic, 'a blocked diagnostic must be published');
    const report = JSON.parse(await readFile(rig.workspace.absoluteArtifactPath(diagnostic!.path), 'utf8')) as any;
    assert.equal(report.status, 'BLOCKED');
    assert.deepEqual([...report.blocked].map((entry: any) => entry.name).sort(), ['communication', 'escalation']);
    assert.deepEqual(report.checks.filter((check: any) => !check.passed).map((check: any) => check.name).sort(), ['communication', 'escalation']);
    const passedNames = new Set(report.checks.filter((check: any) => check.passed).map((check: any) => check.name));
    for (const required of REQUIRED_VERIFICATION_CHECKS) {
      if (required === 'communication' || required === 'escalation') continue;
      assert.ok(passedNames.has(required), `missing local verification: ${required}`);
    }
  } finally {
    await rig.cleanup();
  }
});

test('provisioning aborts immediately on an authority refusal of the fenced verification', async () => {
  const rig = await makeRig(provisioningModel());
  try {
    rig.client.provisionCommunicationError = new WorkerError('EXECUTION_CANCELLED', 'Provisioning is cancelled', false);
    rig.client.queue.push(makeJob('provision_agent', { agent: makeAgent({ status: 'PROVISIONING' }), manifest: makeManifest(), manifestVersion: 1 }));
    assert.equal(await rig.runtime.runOnce(), true);

    // The refusal is fatal, not deferred: no diagnostic, no evaluation, no spend.
    assert.equal(rig.client.completed.length, 0);
    assert.equal(rig.client.failed.at(-1)!.code, 'EXECUTION_CANCELLED');
    assert.equal(rig.client.artifacts.some(artifact => artifact.path.endsWith('provisioning-verification.json')), false, 'no diagnostic may be published under withdrawn authority');
    assert.equal(rig.client.artifacts.some(artifact => artifact.path.endsWith('evaluation.json')), false, 'work must stop before the evaluation');
    assert.equal(rig.client.artifacts.some(artifact => artifact.path.endsWith('restart-check.json')), false, 'work must stop before the restart check');
    assert.equal(rig.client.events.some(event => event.type === 'verification.evaluation'), false);
  } finally {
    await rig.cleanup();
  }
});

test('provisioning proves cross-agent denial against a real sibling agent', async () => {
  const model = provisioningModel();
  const rig = await makeRig(model);
  try {
    const sibling = join(rig.config.sourceRoot, 'agent-2');
    await mkdir(sibling, { recursive: true });
    await writeFile(join(sibling, 'brief.md'), 'SIBLING-SECRET');
    assert.equal(await rig.workspace.otherAgent('agent-1'), 'agent-2');

    rig.client.queue.push(makeJob('provision_agent', { agent: makeAgent({ status: 'PROVISIONING' }), manifest: makeManifest(), manifestVersion: 1 }));
    assert.equal(await rig.runtime.runOnce(), true);

    const permissions = rig.client.events.find(event => event.type === 'verification.permissions')!;
    assert.equal((permissions.data as any).siblingAgent, 'agent-2', 'the probe must target the real sibling');
    const leaked = model.calls.some(call => JSON.stringify(call.messages).includes('SIBLING-SECRET'));
    assert.equal(leaked, false, "a sibling agent's content must never reach the model context");
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
    assert.ok(model.abortedTurns >= 1, 'the in-flight provider request must be cancelled on lease loss');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('run_task delegates a durable actionable message only with a current send grant', async () => {
  for (const revoked of [false, true]) {
    const base = agentLoopModel({ summary: 'Delegated review.', reply: 'Review requested.', deliverable: 'report.md' }, 'report.md');
    const model: ModelAdapter = { name: base.name, turn: async input => {
      if (!input.system.includes('evaluation gate') && !input.messages.some(message => message.role === 'tool')) {
        return { content: null, usage: { modelCalls: 1, inputTokens: 1, outputTokens: 1, cost: null }, toolCalls: [{ id: 'send', name: 'send_message', arguments: { recipientId: 'agent-report', content: 'Review the brief and reply with evidence.', actionable: true } }] };
      }
      return base.turn({ ...input, messages: input.messages.filter(message => message.role !== 'tool' || message.toolCallId !== 'send') });
    } };
    const rig = await makeRig(model);
    try {
      const grant = { tool: 'send_message', operations: ['send'], resource: null, credentialRef: null };
      const manifest = makeManifest();
      manifest.tools.push('send_message'); manifest.permissions.push(grant);
      if (!revoked) rig.client.grants.push(grant);
      const job = makeJob('run_task', { agent: makeAgent({ manifest }), task: { objective: 'Delegate the source review.', constraints: [], deliverable: 'report.md' } });
      if (revoked) {
        await assert.rejects(runJob(rig, job), (error: any) => error.code === 'GRANT_REVOKED');
        assert.equal(rig.client.messages.length, 0);
      } else {
        await runJob(rig, job);
        assert.equal(rig.client.messages[0].recipientId, 'agent-report');
        assert.equal(rig.client.messages[0].actionable, true);
        assert.equal(rig.client.messages[0].taskId, job.taskId);
      }
    } finally { await rig.cleanup(); }
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

test('learn proposes canonical policy for human approval while retaining the evidence-backed lesson', async () => {
  const rig = await makeRig(new FakeModel([{ content: JSON.stringify({
    observation: 'The prior task lacked an attachment.', hypothesis: 'Check sources first.',
    conclusion: 'Validate attachments before drafting.', title: 'Validate inputs',
    canonicalRevision: { title: 'Source policy', content: 'Check source availability before drafting.' },
  }) }]));
  try {
    rig.client.memoryEntries = [{ id: 'prior', title: 'Observation', content: 'Missing attachment', provenance: { artifactIds: ['artifact-prior'], eventIds: [], taskId: null, jobId: null, summary: 'prior' } }];
    await runJob(rig, makeJob('learn', { agent: makeAgent() }));
    const [observation, proposal] = rig.client.memories;
    assert.equal(observation.category, 'episodic');
    assert.equal(observation.status, 'ACTIVE');
    assert.equal(proposal.category, 'canonical');
    assert.equal(proposal.status, 'PROPOSED');
    assert.equal(proposal.supersedesId, null, 'existing canonical knowledge is never overwritten');
    assert.equal(proposal.ownerAgentId, 'agent-1');
    const outcome = rig.client.completed.at(-1)!.outcome as any;
    assert.deepEqual(outcome.learning.memoryIds, [observation.id]);
    assert.equal(outcome.learning.canonicalRevisionId, proposal.id);
    assert.deepEqual(proposal.provenance.artifactIds, outcome.learning.evidence.artifactIds);
  } finally { await rig.cleanup(); }
});

test('learn propagates memory authority failures before invoking the model', async () => {
  const model = new FakeModel([]);
  const rig = await makeRig(model);
  try {
    rig.client.listMemory = async () => { throw new WorkerError('MEMORY_FORBIDDEN', 'Access revoked', false); };
    await assert.rejects(runJob(rig, makeJob('learn', { agent: makeAgent() })), (error: any) => error.code === 'MEMORY_FORBIDDEN');
    assert.equal(model.calls.length, 0);
    assert.equal(rig.client.memories.length, 0);
  } finally { await rig.cleanup(); }
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

test('retirement performs and verifies cleanup and consultant knowledge transfer', async () => {
  const rig = await makeRig(new FakeModel([]));
  try {
    const manifest = makeManifest({
      agent: { id: 'agent-1', name: 'Consultant', type: 'consultant' },
      consultant: { deliverable: 'Review', deadline: null, terminationCondition: 'Accepted.', knowledgeRecipientIds: ['agent-2'] },
    });
    // Seed durable knowledge that retirement must preserve, verify and transfer.
    await rig.workspace.replaceAttemptFile('agent-1', 'job-seed', 1, 'memory/working.json', '{"lesson":"keep me"}', () => {});
    const job = makeJob('retire_agent', { agent: makeAgent({ status: 'TERMINATING', manifest }), reason: 'Mission complete.' });
    await runJob(rig, job);

    assert.equal(rig.client.failed.length, 0, JSON.stringify(rig.client.failed));
    const outcome = rig.client.completed.at(-1)!.outcome as any;
    assert.equal(outcome.kind, 'retire_agent');
    assert.equal(outcome.runtimeDisabled, true);
    assert.equal(outcome.knowledgePreserved, true);
    assert.equal(outcome.credentialsRevoked, true);
    assert.ok(outcome.evidence.artifactIds.length >= 1);
    // The retirement marker and the transferred knowledge really exist on disk.
    assert.match(await rig.workspace.read('workspace', 'agent-1', 'runtime-disabled.json'), /disabledAt/);

    // The recipient receives the actual knowledge bytes, not just a path index.
    const transferIndex = JSON.parse(await rig.workspace.read('workspace', 'agent-2', 'consultant-transfer/agent-1/index.json')) as any;
    assert.equal(transferIndex.scope, 'private');
    assert.equal(transferIndex.from, 'agent-1');
    assert.equal(transferIndex.knowledge.length, 1);
    const entry = transferIndex.knowledge[0];
    assert.equal(entry.sourcePath, 'memory/working.json');
    assert.equal(entry.from, 'agent-1');
    assert.equal(entry.sha256, createHash('sha256').update('{"lesson":"keep me"}').digest('hex'));
    const copied = await rig.workspace.read('workspace', 'agent-2', `consultant-transfer/agent-1/knowledge/${entry.name}`);
    assert.equal(copied, '{"lesson":"keep me"}', 'the recipient must be able to read the transferred content itself');
  } finally {
    await rig.cleanup();
  }
});

test('retirement fails when there is no durable knowledge to verify', async () => {
  const rig = await makeRig(new FakeModel([]));
  try {
    rig.client.queue.push(makeJob('retire_agent', { agent: makeAgent({ status: 'TERMINATING' }), reason: 'No knowledge.' }));
    assert.equal(await rig.runtime.runOnce(), true);
    assert.equal(rig.client.completed.length, 0);
    assert.equal(rig.client.failed.at(-1)!.code, 'KNOWLEDGE_MISSING');
  } finally {
    await rig.cleanup();
  }
});

test('retirement fails closed instead of dropping knowledge above its cap', async () => {
  const rig = await makeRig(new FakeModel([]));
  try {
    for (let index = 0; index < 101; index++) {
      await rig.workspace.replaceAttemptFile('agent-1', 'seed', 1, `memory/item-${index}.txt`, `note ${index}`, () => {});
    }
    rig.client.queue.push(makeJob('retire_agent', { agent: makeAgent({ status: 'TERMINATING' }), reason: 'Too much knowledge.' }));
    assert.equal(await rig.runtime.runOnce(), true);

    // Nothing is silently dropped, and no unverified preservation is claimed.
    assert.equal(rig.client.completed.length, 0);
    assert.equal(rig.client.failed.at(-1)!.code, 'KNOWLEDGE_LIMIT_EXCEEDED');
    assert.equal(rig.client.artifacts.some(artifact => artifact.path.endsWith('retirement.json')), false);
  } finally {
    await rig.cleanup();
  }
});

test('run_task includes retrieved scoped memory in the model context', async () => {
  const model = agentLoopModel({ summary: 'Used the prior lesson.', reply: 'done', deliverable: 'report.md' }, 'report.md');
  const rig = await makeRig(model);
  try {
    rig.client.memoryEntries = [{ id: 'memory-1', title: 'Prior lesson', category: 'episodic', content: 'ALWAYS cite the approved brief.' }];
    const job = makeJob('run_task', {
      agent: makeAgent(),
      task: { id: 'task-1', objective: 'Write a report', constraints: [], deliverable: 'report.md', deadline: null },
      inputMessage: null,
    }, { taskId: 'task-1' });
    await runJob(rig, job);

    assert.equal(rig.client.failed.length, 0, JSON.stringify(rig.client.failed));
    const prompt = String(model.calls[0].messages[0].content ?? '');
    assert.match(prompt, /ALWAYS cite the approved brief\./);
  } finally {
    await rig.cleanup();
  }
});

test('run_task fails closed when scoped memory retrieval is refused', async () => {
  const model = agentLoopModel({ summary: 'x', reply: 'y', deliverable: 'report.md' }, 'report.md');
  const rig = await makeRig(model);
  try {
    // An authorization failure must not become "the agent has no memory".
    rig.client.memoryError = new WorkerError('HTTP_403', 'Memory retrieval is not authorized', false);
    rig.client.queue.push(makeJob('run_task', {
      agent: makeAgent(),
      task: { id: 'task-1', objective: 'Write a report', constraints: [], deliverable: 'report.md', deadline: null },
      inputMessage: null,
    }, { taskId: 'task-1' }));
    assert.equal(await rig.runtime.runOnce(), true);

    assert.equal(rig.client.completed.length, 0);
    assert.equal(rig.client.failed.at(-1)!.code, 'HTTP_403');
    assert.equal(model.calls.length, 0, 'no provider request may follow the refusal');
  } finally {
    await rig.cleanup();
  }
});

test('provisioning rejects an evaluation that duplicates or invents criteria', async () => {
  const model = new FakeModel(input => {
    if (input.system.includes('self-check')) {
      const last = input.messages.at(-1);
      return { content: last && last.role === 'user' ? last.content : '' };
    }
    if (input.system.includes('evaluate a provisioning run')) {
      const payload = JSON.parse(String(input.messages.at(-1)?.content ?? '{}')) as { criteria?: string[]; evidence?: { id: string }[] };
      const evidenceId = (payload.evidence ?? [{ id: 'missing' }])[0]!.id;
      const criterion = (payload.criteria ?? ['missing'])[0]!;
      // Two judgements for one criterion and one renamed criterion.
      return { content: JSON.stringify({ passed: true, criteria: [
        { criterion, passed: true, evidenceIds: [evidenceId] },
        { criterion, passed: true, evidenceIds: [evidenceId] },
        { criterion: 'A criterion nobody requested', passed: true, evidenceIds: [evidenceId] },
      ] }) };
    }
    const toolResults = input.messages.filter(message => message.role === 'tool').length;
    if (toolResults === 0) return { toolCalls: [{ id: 'call-read', name: 'read_file', arguments: { root: 'briefs', path: 'brief.md' } }] };
    if (toolResults === 1) return { toolCalls: [{ id: 'call-write', name: 'write_file', arguments: { path: 'provision-report.md', content: '# Report' } }] };
    return { content: JSON.stringify({ summary: 'done', reply: 'verified', deliverable: 'provision-report.md', escalation: { trigger: 'missing evidence', situation: 's', recommendation: 'r' } }) };
  });
  const rig = await makeRig(model);
  try {
    rig.client.queue.push(makeJob('provision_agent', { agent: makeAgent({ status: 'PROVISIONING' }), manifest: makeManifest(), manifestVersion: 1 }));
    assert.equal(await rig.runtime.runOnce(), true);
    assert.equal(rig.client.completed.length, 0);
    assert.equal(rig.client.failed.at(-1)!.code, 'EVALUATION_FAILED');
  } finally {
    await rig.cleanup();
  }
});

test('run_task refuses completion when the deliverable does not satisfy the task', async () => {
  const model = new FakeModel(input => {
    if (input.system.includes('evaluation gate')) {
      const payload = JSON.parse(String(input.messages.at(-1)?.content ?? '{}')) as { criteria?: string[]; evidence?: { id: string }[] };
      const evidenceId = (payload.evidence ?? [{ id: 'missing' }])[0]!.id;
      return { content: JSON.stringify({ passed: true, deliverableMatches: false, objectiveAddressed: true, constraintsSatisfied: true,
        criteria: (payload.criteria ?? []).map(criterion => ({ criterion, passed: true, evidenceIds: [evidenceId] })) }) };
    }
    const toolResults = input.messages.filter(message => message.role === 'tool').length;
    if (toolResults === 0) return { toolCalls: [{ id: 'call-read', name: 'read_file', arguments: { root: 'briefs', path: 'brief.md' } }] };
    if (toolResults === 1) return { toolCalls: [{ id: 'call-write', name: 'write_file', arguments: { path: 'report.md', content: 'Unrelated bytes.' } }] };
    return { content: JSON.stringify({ summary: 'Wrote something.', reply: 'done', deliverable: 'report.md' }) };
  });
  const rig = await makeRig(model);
  try {
    rig.client.queue.push(makeJob('run_task', {
      agent: makeAgent(),
      task: { id: 'task-1', objective: 'Write a cited report', constraints: [], deliverable: 'report.md', deadline: null },
      inputMessage: null,
    }, { taskId: 'task-1' }));
    assert.equal(await rig.runtime.runOnce(), true);
    assert.equal(rig.client.completed.length, 0);
    assert.equal(rig.client.failed.at(-1)!.code, 'TASK_EVALUATION_FAILED');
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
