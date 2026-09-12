/** Real API/runtime acceptance. No fixture transport, seeded agents, or automatic approvals. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, readdir, mkdir, lstat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function assertRecruit(hire, parentId, taskId, events) {
  assert.equal(hire.requestedBy.kind, 'agent', 'Descendant must be requested by an executing agent');
  assert.equal(hire.requestedBy.id, parentId);
  assert.equal(hire.proposedManager, parentId);
  assert.equal(hire.originatingTaskId, taskId);
  assert.ok(hire.originatingJobId, 'Recruitment must retain a live originating job');
  assert.ok(events.some(e => e.jobId === hire.originatingJobId && e.type === 'model.execution' && e.data.toolCalls?.includes('request_hire')), 'Recruitment must originate in a persisted real model tool call');
}
export function assertTask(task, events, usage) {
  assert.equal(task.status, 'COMPLETED');
  assert.ok(task.evidence?.artifactIds.length, 'Completed task must publish artifacts');
  assert.ok(task.evidence?.eventIds.length, 'Completed task must cite execution events');
  assert.ok(events.some(e => e.taskId === task.id && e.type === 'model.execution'), 'Task requires persisted model execution');
  assert.ok(usage.some(u => u.jobId === task.evidence.jobId && u.status === 'SETTLED' && u.modelCalls > 0 && u.inputTokens > 0 && u.outputTokens > 0), 'Task requires settled real token usage');
}

export async function main() {
  const env = process.env;
  const stage = process.argv[2] ?? 'all';
  assert.ok(['prepare', 'live', 'support', 'restart', 'all'].includes(stage), 'Stage: prepare | live | support | restart | all');
  for (const key of ['E2E_API_ORIGIN', 'E2E_OPERATOR_TOKEN', 'E2E_MODEL_NAME', 'E2E_SOURCE_ROOT', 'E2E_BRIEF_DIR']) assert.ok(env[key], `BLOCKED: ${key} is required`);
  assert.ok(process.stdin.isTTY, 'BLOCKED: interactive terminal required to review and approve exact manifests');
  const statePath = env.E2E_STATE_PATH ?? '/tmp/agent-factory-live.json';
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(), '', 'BLOCKED: commit changes before recording revision-bound live evidence');
  const origin = new URL(env.E2E_API_ORIGIN).origin;
  let state;
  try { state = JSON.parse(await readFile(statePath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  state ??= { runId: randomUUID(), revision, origin, model: env.E2E_MODEL_NAME, startedAt: new Date().toISOString(), completed: [], actions: [], ids: {} };
  assert.equal(state.revision, revision, 'Use a new E2E_STATE_PATH after changing revision; rerun on actual final main');
  assert.equal(state.origin, origin); assert.equal(state.model, env.E2E_MODEL_NAME);
  const save = () => writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const confirm = async (label, record) => {
    const digest = sha256(JSON.stringify(record));
    console.log(`\n${label}\n${JSON.stringify(record, null, 2)}\nSHA256 ${digest}`);
    assert.equal((await terminal.question(`Type APPROVE ${digest} to authorize exactly this action: `)).trim(), `APPROVE ${digest}`, 'Operator declined; no decision submitted');
    state.actions.push({ at: new Date().toISOString(), label, digest, record }); await save();
  };
  let cookie;
  async function request(path, body) {
    const response = await fetch(new URL(path, origin), { method: body === undefined ? 'GET' : 'POST', headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': sha256(`${state.runId}:${path}:${JSON.stringify(body)}`) }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    if (path === '/v1/session') cookie = response.headers.get('set-cookie')?.split(';')[0];
    const result = await response.json();
    assert.ok(response.ok, `${path}: ${response.status} ${result.error?.code ?? ''} ${result.error?.message ?? ''}`);
    return result;
  }
  const get = async path => (await request(path)).data;
  const post = async (path, body) => (await request(path, body)).data;
  async function list(path) {
    let cursor; const rows = [];
    do { const page = await request(`${path}${path.includes('?') ? '&' : '?'}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); rows.push(...page.data); cursor = page.nextCursor; } while (cursor);
    return rows;
  }
  async function wait(label, read, accept) {
    const end = Date.now() + Number(env.E2E_TIMEOUT_MS ?? 900_000);
    while (Date.now() < end) { const result = await read(); if (accept(result)) return result; if (['FAILED', 'CANCELLED', 'REJECTED', 'ESCALATED'].includes(result?.status)) throw new Error(`${label}: ${result.status}; inspect durable events`); await new Promise(resolve => setTimeout(resolve, 2000)); }
    throw new Error(`BLOCKED: ${label} timed out; no successful evidence inferred`);
  }
  async function stageBriefs(agentId) {
    assert.match(agentId, /^[A-Za-z0-9_-]+$/, 'Scoped source directory must be a plain agent ID');
    const root = resolve(env.E2E_BRIEF_DIR); const entries = [];
    async function walk(directory, relative = '') {
      assert.ok(!(await lstat(directory)).isSymbolicLink(), 'Source directories must not be symlinks');
      for (const name of await readdir(directory)) {
        const path = join(directory, name); const info = await lstat(path); const relativePath = join(relative, name);
        assert.ok(!info.isSymbolicLink(), 'Approved sources must not contain symlinks');
        if (info.isDirectory()) await walk(path, relativePath);
        else { assert.ok(info.isFile(), 'Sources must be regular files'); const bytes = await readFile(path); entries.push({ relativePath, bytes, sha256: sha256(bytes) }); }
      }
    }
    await walk(root); assert.ok(entries.length, 'BLOCKED: approved source brief directory is empty');
    const descriptor = entries.map(({ relativePath, bytes, sha256 }) => ({ relativePath, size: bytes.length, sha256 })).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    const digest = sha256(JSON.stringify(descriptor));
    if (state.sourceDigest) assert.equal(digest, state.sourceDigest, 'Approved briefs changed during this run');
    else { await confirm('Approve source briefs to seed into each newly requested agent workspace', { root, files: descriptor }); state.sourceDigest = digest; await save(); }
    const sourceRoot = resolve(env.E2E_SOURCE_ROOT); await mkdir(sourceRoot, { recursive: true }); assert.ok(!(await lstat(sourceRoot)).isSymbolicLink());
    const target = join(sourceRoot, agentId); await mkdir(target, { recursive: true }); assert.ok(!(await lstat(target)).isSymbolicLink());
    for (const entry of entries) {
      const parts = entry.relativePath.split('/'); let directory = target;
      for (const part of parts.slice(0, -1)) { directory = join(directory, part); await mkdir(directory, { recursive: true }); assert.ok(!(await lstat(directory)).isSymbolicLink()); }
      const destination = join(target, entry.relativePath);
      try { await writeFile(destination, entry.bytes, { flag: 'wx', mode: 0o644 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; assert.ok(!(await lstat(destination)).isSymbolicLink()); assert.equal(sha256(await readFile(destination)), entry.sha256, 'Existing scoped brief differs from approved source'); }
    }
    state.actions.push({ label: 'approved-source-staging', agentId, digest, files: descriptor }); await save();
  }
  async function verified(hireId) {
    let hire = await wait('manifest compilation', () => get(`/v1/hiring-requests/${hireId}`), h => ['AWAITING_APPROVAL', 'ACTIVE'].includes(h.status));
    await stageBriefs(hire.agentId);
    if (hire.status === 'AWAITING_APPROVAL') {
      assert.equal(hire.manifest.runtime.model, state.model, 'Compiled manifest must use the configured real model');
      await confirm('Approve hire manifest, permissions, budget, reporting line and consultant termination terms', hire);
      hire = await post(`/v1/hiring-requests/${hire.id}/decision`, { decision: 'approve', expectedVersion: hire.version, manifestVersion: hire.manifestVersion, reason: `Live acceptance ${state.runId}: human reviewed exact manifest` });
    }
    const detail = await wait('behavioral provisioning', () => get(`/v1/agents/${hire.agentId}`), d => { if (['FAILED', 'REMEDIATING'].includes(d.agent.status)) throw new Error(`Provisioning ${hire.agentId} FAILED`); return d.agent.status === 'ACTIVE'; });
    assert.ok(detail.verification.length >= 12);
    for (const name of detail.agent.manifest.evaluation.requiredVerificationChecks) { const check = detail.verification.find(v => v.name === name); assert.ok(check?.passed && (check.evidence.artifactIds.length || check.evidence.eventIds.length), `${name}: missing positive evidence`); }
    assert.equal(detail.agent.approvedManifestVersion, detail.agent.manifestVersion);
    assert.equal(detail.agent.provisionedBy, (await get('/v1/organization')).coordinator.id);
    state.actions.push({ label: 'verified', agentId: hire.agentId, checks: detail.verification }); await save();
    return hire.agentId;
  }
  async function task(agentId, objective, key) {
    let id = state.ids[key];
    if (!id) { id = (await post('/v1/tasks', { agentId, objective, constraints: ['Read approved source briefs; cite sources. Never invent results.', 'Do not create any hire unless this objective identifies a genuine capability gap.'], deliverable: `${key}.md`, deadline: null })).id; state.ids[key] = id; await save(); }
    return wait(key, () => get(`/v1/tasks/${id}`), t => t.status === 'COMPLETED');
  }
  async function evidence(taskRecord) {
    assertTask(taskRecord, await list('/v1/events'), await list('/v1/usage'));
    const artifacts = [];
    for (const id of taskRecord.evidence.artifactIds) { const metadata = await get(`/v1/artifacts/${id}`); const response = await fetch(new URL(`/v1/artifacts/${id}/content`, origin), { headers: { cookie }, signal: AbortSignal.timeout(30_000) }); assert.ok(response.ok); const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(bytes.length, metadata.size); assert.equal(sha256(bytes), metadata.sha256); artifacts.push({ ...metadata, preview: bytes.toString('utf8').slice(0, 16000) }); }
    const messages = await list('/v1/messages');
    assert.ok(messages.some(m => m.sender.kind === 'agent' && m.sender.id === taskRecord.agentId && m.taskId === taskRecord.id && m.recipientId === taskRecord.requestedBy.id && m.content.trim()), 'Completed task must persist an actual reply to its requester');
    state.actions.push({ label: 'task-evidence', task: taskRecord, artifacts }); await save();
  }
  async function recruit(parentId, key, role, type = 'employee') {
    if (state.ids[key]) return state.ids[key];
    const t = await task(parentId, `Review the approved briefs for your mission. Identify the genuine capability gap requiring a ${role}. If justified, invoke request_hire exactly once for a ${type} with its bounded mission and benefit, then write a sourced gap analysis. Do not pretend a hire succeeded without the tool.`, `${key}-request`);
    await evidence(t);
    const hire = await wait(`${key}: genuine recruitment`, () => list('/v1/hiring-requests'), hs => hs.some(h => h.requestedBy.id === parentId && h.originatingTaskId === t.id));
    const selected = hire.filter(h => h.requestedBy.id === parentId && h.originatingTaskId === t.id); assert.equal(selected.length, 1, 'Expected one deliberate hire');
    assertRecruit(selected[0], parentId, t.id, await list('/v1/events'));
    assert.equal(selected[0].proposal.agentType, type);
    state.ids[key] = await verified(selected[0].id); await save(); return state.ids[key];
  }
  try {
    await request('/v1/session', { token: env.E2E_OPERATOR_TOKEN }); assert.ok(cookie);
    const org = await get('/v1/organization');
    state.organizationId ??= org.organization.id; assert.equal(state.organizationId, org.organization.id);
    const stages = stage === 'all' ? ['prepare', 'live', 'support', 'restart'] : [stage];
    for (const current of stages) {
      if (state.completed.includes(current)) { console.log(`Already recorded ${current} at ${revision}; revalidating happens on a fresh run.`); continue; }
      if (current === 'prepare') {
        if (!state.actions.some(a => a.label === 'start')) { assert.equal((await list('/v1/agents')).length, 0, 'Use a clean deployment seeded only with organization, teams, standards and briefs'); state.actions.push({ label: 'start' }); await save(); }
        for (const [key, role] of [['research', 'Research Lead'], ['delivery', 'Delivery Lead']]) {
          if (!state.ids[`${key}-hire`]) {
            const proposal = { justification: 'Build the source-grounded organization required by the operator objective.', role, mission: `Lead ${key} work from approved source briefs and identify justified capability gaps.`, teamId: org.teams[0].id, proposedManagerId: org.organization.humanPrincipalId, proposedManagerKind: 'human', agentType: 'employee', responsibilities: ['Read approved briefs, produce sourced artifacts, and recruit only for justified capability gaps.'], tools: ['workspace-files', 'request_hire', 'send_message'], grants: [{ tool: 'workspace-files', operations: ['read', 'write', 'list'], resource: null, credentialRef: null }, { tool: 'request_hire', operations: ['request'], resource: null, credentialRef: null }, { tool: 'send_message', operations: ['send'], resource: null, credentialRef: null }], expectedBenefit: 'Verified source-grounded work and governed recursive recruitment.', budget: { modelCallsDaily: 200, externalSpendDaily: 2, currency: 'USD', maxConcurrentTasks: 1 } };
            await confirm('Create initial hiring request (budget is reviewed again with the manifest)', proposal);
            state.ids[`${key}-hire`] = (await post('/v1/hiring-requests', proposal)).id; await save();
          }
          state.ids[key] = await verified(state.ids[`${key}-hire`]); await save();
        }
        await recruit(state.ids.research, 'analyst', 'Evidence Analyst'); await recruit(state.ids.delivery, 'writer', 'Report Writer');
        assert.equal((await list('/v1/agents')).filter(a => a.status === 'ACTIVE').length, 4);
      }
      if (current === 'live') {
        assert.ok(state.completed.includes('prepare'), 'Run prepare first');
        const fifth = await recruit(state.ids.analyst, 'reviewer', 'Source Reviewer');
        const delegation = await task(state.ids.analyst, `Delegate a small sourced review of the approved briefs to your new direct report ${fifth} using send_message with recipientId equal to that ID and actionable:true, then persist the actual returned message ID in your deliverable. Do not perform their task yourself.`, 'delegate-fifth'); await evidence(delegation);
        const tasks = await wait('fifth task delegated by its requesting agent', () => list('/v1/tasks'), ts => ts.some(t => t.agentId === fifth && t.requestedBy.kind === 'agent' && t.requestedBy.id === state.ids.analyst && t.createdAt >= delegation.createdAt));
        const child = tasks.find(t => t.agentId === fifth && t.requestedBy.id === state.ids.analyst && t.createdAt >= delegation.createdAt);
        await evidence(await wait('fifth deliverable and reply', () => get(`/v1/tasks/${child.id}`), t => t.status === 'COMPLETED'));
        assert.equal((await list('/v1/agents')).filter(a => a.status === 'ACTIVE').length, 5);
        const escalations = (await list('/v1/escalations')).filter(e => e.agentId === fifth);
        assert.ok(escalations.length, 'Provisioning must persist a manager-routed escalation');
        for (const escalation of escalations) { assert.equal(escalation.requestedFrom, state.ids.analyst); if (escalation.status === 'OPEN') { await confirm('Resolve manager-routed provisioning escalation as operator', escalation); await post(`/v1/escalations/${escalation.id}/resolve`, { expectedVersion: escalation.version, resolution: 'Operator reviewed the persisted behavioral provisioning evidence and manager route.', followUp: null }); } }
      }
      if (current === 'support') {
        assert.ok(state.completed.includes('live'), 'Run live first');
        const agentId = state.ids.reviewer;
        if (!state.ids.reconfigurationDone) {
          const old = (await get(`/v1/agents/${agentId}`)).agent;
          if (!state.ids.reconfiguration) {
            const manifest = structuredClone(old.manifest);
            manifest.standards = [...manifest.standards, `Acceptance ${state.runId}: explicitly identify unsupported claims.`];
            await confirm('Propose exact manifest reconfiguration', manifest);
            const proposal = await post(`/v1/agents/${agentId}/lifecycle`, { action: 'reconfigure', expectedVersion: old.version, reason: 'Add reviewed evidence quality standard.', manifest });
            state.ids.reconfiguration = proposal.governance.id; state.ids.priorManifestVersion = old.manifestVersion; await save();
          }
          const g = (await list('/v1/governance')).find(row => row.id === state.ids.reconfiguration);
          if (g.status === 'PENDING') { await confirm('Approve exact reconfiguration and rerun behavioral verification', g); await post(`/v1/governance/${g.id}/decision`, { expectedVersion: g.version, decision: 'approve', reason: 'Human reviewed exact manifest change.' }); }
          const updated = await wait('reconfiguration verification', () => get(`/v1/agents/${agentId}`), d => { if (d.agent.status === 'REMEDIATING') throw new Error('Reconfiguration failed; inspect verification evidence'); return d.agent.status === 'ACTIVE'; });
          assert.equal(updated.agent.manifestVersion, state.ids.priorManifestVersion + 1);
          assert.equal(updated.agent.approvedManifestVersion, updated.agent.manifestVersion);
          for (const name of updated.agent.manifest.evaluation.requiredVerificationChecks) assert.ok(updated.verification.some(c => c.name === name && c.passed && (c.evidence.eventIds.length || c.evidence.artifactIds.length)));
          state.ids.reconfigurationDone = true; await save();
        }
        if (!state.ids.admissionDenialDone) {
          let paused = (await get(`/v1/agents/${agentId}`)).agent;
          if (paused.status === 'ACTIVE') { await confirm('Pause employee to verify work is denied outside ACTIVE', paused); paused = (await post(`/v1/agents/${agentId}/lifecycle`, { action: 'pause', expectedVersion: paused.version, reason: 'Exercise inactive work admission refusal.' })).agent; }
          const denied = await fetch(new URL('/v1/tasks', origin), { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'idempotency-key': `${state.runId}-denied-task` }, body: JSON.stringify({ agentId, objective: 'This task must be denied while paused.', constraints: [], deliverable: 'must-not-exist.md', deadline: null }), signal: AbortSignal.timeout(30000) });
          const denial = await denied.json(); assert.equal(denied.status, 409); assert.equal(denial.error.code, 'AGENT_INACTIVE');
          const escalation = await post('/v1/escalations', { agentId, taskId: null, severity: 'low', category: 'acceptance-admission-denial', situation: 'The live API correctly refused a task for a paused agent.', attemptedActions: ['POST /v1/tasks while PAUSED returned AGENT_INACTIVE'], reason: 'Operator must review before resuming work.', recommendation: 'Confirm refusal and resume the verified employee.', requestedFrom: paused.manifest.organization.managerId });
          await confirm('Resolve observed admission denial and resume employee', { denial, escalation, paused });
          await post(`/v1/escalations/${escalation.id}/resolve`, { expectedVersion: escalation.version, resolution: 'Human reviewed the actual AGENT_INACTIVE refusal; safe to resume.', followUp: null });
          await post(`/v1/agents/${agentId}/lifecycle`, { action: 'resume', expectedVersion: paused.version, reason: 'Operator resolved the admission-denial exercise.' });
          state.ids.admissionDenialDone = true; await save();
        }
        if (!state.ids.learnSchedule) { state.ids.learnSchedule = (await post('/v1/schedules', { agentId, kind: 'learn', intervalSeconds: 86400, nextRunAt: new Date().toISOString(), payload: {} })).id; await save(); }
        const lessons = await wait('evidence-backed learning', () => list('/v1/learning'), rows => rows.some(l => l.agentId === agentId));
        const lesson = lessons.find(l => l.agentId === agentId); assert.ok(lesson.evidence.artifactIds.length && lesson.memoryIds.length);
        const reuse = await task(agentId, 'Use your retrieved evidence-backed lesson to improve a new sourced review. Explain which lesson changed your approach and show the improvement in the deliverable.', 'learning-reuse'); await evidence(reuse);
        assert.ok((await list('/v1/events')).some(e => e.taskId === reuse.id && e.type === 'memory.retrieved' && lesson.memoryIds.some(id => e.data.memoryIds?.includes(id))), 'Subsequent execution must record retrieval of the actual lesson');
        await confirm('Inspect delivered artifact and confirm the lesson changed the work', { lesson, task: reuse, evidence: state.actions.findLast(a => a.label === 'task-evidence') });
        if (!state.ids.canonical) { const proposedCanonical = await post('/v1/memory', { ownerAgentId: agentId, category: 'canonical', title: `Reviewed lesson ${state.runId}`, content: lesson.conclusion, scope: { visibility: 'private', teamId: null, agentIds: [] }, provenance: lesson.evidence, expiresAt: null, supersedesId: null }); assert.equal(proposedCanonical.status, 'PROPOSED'); state.ids.canonical = proposedCanonical.id; await save(); }
        const memory = await get(`/v1/memory/${state.ids.canonical}`); assert.ok(['PROPOSED', 'ACTIVE'].includes(memory.status));
        const governance = (await list('/v1/governance')).find(g => g.kind === 'canonical_revision' && g.changes.memoryId === memory.id); assert.ok(governance);
        if (memory.status === 'PROPOSED') { await confirm('Approve exact canonical knowledge revision', { memory, governance }); await post(`/v1/governance/${governance.id}/decision`, { expectedVersion: governance.version, decision: 'approve', reason: 'Human reviewed evidence-backed canonical revision.' }); assert.equal((await get(`/v1/memory/${memory.id}`)).status, 'ACTIVE'); }
        const consultant = await recruit(state.ids.delivery, 'consultant', 'bounded source audit consultant', 'consultant');
        await evidence(await task(consultant, 'Perform the bounded source audit in your approved consultant manifest, cite the approved briefs and preserve your findings for the knowledge recipients.', 'consultant-work'));
        const detail = await get(`/v1/agents/${consultant}`); if (detail.agent.status !== 'ARCHIVED') { await confirm('Request governed consultant retirement', detail.agent);
        const existingRetirement = (await list('/v1/governance')).find(g => g.agentId === consultant && g.kind === 'retire' && g.status === 'PENDING');
        const action = existingRetirement ? { governance: existingRetirement } : await post(`/v1/agents/${consultant}/lifecycle`, { action: 'retire', expectedVersion: detail.agent.version, reason: 'Bounded consultant deliverable reviewed and accepted.' });
        await confirm('Approve consultant retirement and preserved knowledge recipients', action.governance); await post(`/v1/governance/${action.governance.id}/decision`, { expectedVersion: action.governance.version, decision: 'approve', reason: 'Human approves retirement after reviewing the delivered audit.' });
        await wait('consultant retirement', () => get(`/v1/agents/${consultant}`), d => d.agent.status === 'ARCHIVED'); }
        const resources = (await list('/v1/resources')).filter(r => r.agentId === consultant); assert.ok(resources.every(r => r.status === 'REVOKED'));
        const cleanup = (await list('/v1/events')).find(e => e.agentId === consultant && e.type === 'retirement.cleanup'); assert.ok(cleanup?.data.preservedFiles > 0 && cleanup.data.transferredBytes > 0 && cleanup.data.transferredTo.includes(state.ids.delivery));
        await evidence(await task(state.ids.delivery, `Read your own workspace consultant-transfer/${consultant}/index.json and the transferred knowledge files. Produce a sourced summary proving you can retrieve the retired consultant knowledge. Do not claim retrieval without read_file results.`, 'consultant-knowledge-retrieval'));
        const temporaryEmployee = await recruit(state.ids.delivery, 'retirement-employee', 'temporary evidence indexing employee');
        await evidence(await task(temporaryEmployee, 'Index the approved source briefs into a small sourced durable artifact for this retirement exercise.', 'employee-retirement-work'));
        let retiring = (await get(`/v1/agents/${temporaryEmployee}`)).agent;
        if (retiring.status !== 'ARCHIVED') {
          await confirm('Request retirement of separate employee; retain all five demo employees', retiring);
          const proposal = await post(`/v1/agents/${temporaryEmployee}/lifecycle`, { action: 'retire', expectedVersion: retiring.version, reason: 'Standalone employee retirement acceptance; five employee demo graph is preserved.' });
          await confirm('Approve separate employee retirement', proposal.governance);
          await post(`/v1/governance/${proposal.governance.id}/decision`, { expectedVersion: proposal.governance.version, decision: 'approve', reason: 'Reviewed bounded exercise output and preserved knowledge.' });
          await wait('separate employee archive', () => get(`/v1/agents/${temporaryEmployee}`), d => d.agent.status === 'ARCHIVED');
        }
        assert.equal((await list('/v1/agents')).filter(a => a.status === 'ACTIVE').length, 5);
        assert.ok((await list('/v1/events')).some(e => e.agentId === temporaryEmployee && e.type === 'retirement.cleanup' && e.data.preservedFiles > 0));
      }
      if (current === 'restart') {
        assert.ok(state.completed.includes('support'), 'Run support first');
        assert.ok(env.E2E_STOP_ARGV, 'BLOCKED: E2E_STOP_ARGV must abruptly stop API and worker during executing work (for example docker compose kill -s SIGKILL api worker)');
        assert.ok(env.E2E_RESTART_ARGV, 'BLOCKED: E2E_RESTART_ARGV must be a JSON argv array that actually restarts API and worker against their durable volumes');
        const stopArgv = JSON.parse(env.E2E_STOP_ARGV); assert.ok(Array.isArray(stopArgv) && stopArgv.length && stopArgv.every(v => typeof v === 'string'));
        const argv = JSON.parse(env.E2E_RESTART_ARGV); assert.ok(Array.isArray(argv) && argv.length && argv.every(v => typeof v === 'string'));
        const before = { agents: await list('/v1/agents'), memory: await list('/v1/memory'), tasks: await list('/v1/tasks') };
        await confirm('Restart API and worker processes while preserving database and artifact volumes', { stopArgv, argv, revision });
        if (!state.ids.inflightTask) { state.ids.inflightTask = (await post('/v1/tasks', { agentId: state.ids.reviewer, objective: 'Read every approved source brief and produce a thorough sourced review with explicit uncertainties. Use your prior scoped learning.', constraints: ['Read approved briefs and write a real deliverable.'], deliverable: 'inflight-recovery.md', deadline: null })).id; await save(); }
        const inflight = await wait('task running before abrupt restart', () => get(`/v1/tasks/${state.ids.inflightTask}`), t => { if (t.status === 'COMPLETED') throw new Error('BLOCKED: task finished before interruption; use a new run to exercise actual in-flight recovery'); return t.status === 'EXECUTING'; });
        const claimed = (await list('/v1/events')).filter(e => e.taskId === inflight.id && e.type === 'job.claimed').at(-1); assert.ok(claimed);
        if (!before.tasks.some(t => t.id === inflight.id)) before.tasks.push(inflight);
        execFileSync(stopArgv[0], stopArgv.slice(1), { stdio: 'inherit', timeout: 180_000 });
        execFileSync(argv[0], argv.slice(1), { stdio: 'inherit', timeout: 180_000 });
        await wait('API after restart', async () => { try { return await get('/v1/organization'); } catch { return null; } }, Boolean);
        for (const [name, rows] of Object.entries(before)) { const after = await list(`/v1/${name}`); const ids = after.map(r => r.id); assert.equal(new Set(ids).size, ids.length, `${name}: records must not duplicate`); for (const row of rows) assert.ok(ids.includes(row.id), `${name}: durable record ${row.id} must survive restart`); }
        const recoveredTask = await wait('expired in-flight lease recovery', () => get(`/v1/tasks/${inflight.id}`), t => t.status === 'COMPLETED'); await evidence(recoveredTask);
        const recoveryEvents = await list('/v1/events');
        assert.ok(recoveryEvents.some(e => e.type === 'job.recovered' && e.jobId === claimed.jobId), 'Interrupted job must record lease recovery');
        assert.ok(recoveryEvents.some(e => e.type === 'job.claimed' && e.jobId === claimed.jobId && e.attempt > claimed.attempt), 'Recovered execution must claim a later fenced attempt');
        await evidence(await task(state.ids.reviewer, 'After the service restart, retrieve your prior scoped lesson and source briefs; produce a new sourced review grounded in that recovered context.', 'restart-work'));
      }
      state.completed.push(current); await save(); console.log(`RECORDED ${current}: ${statePath}`);
    }
    if (['prepare', 'live', 'support', 'restart'].every(s => state.completed.includes(s))) { state.finishedAt = new Date().toISOString(); await save(); console.log(`LIVE WORKFLOW COMPLETE at ${revision}. Evidence: ${statePath}. Independent security/failure and UI gates remain required; this is not sole merge authorization.`); }
  } finally { terminal.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 2; });
