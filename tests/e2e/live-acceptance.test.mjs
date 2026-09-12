import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertRecruit, assertTask, sha256 } from './live-acceptance.mjs';
const hire = { requestedBy: { kind: 'agent', id: 'manager' }, proposedManager: 'manager', originatingTaskId: 'task', originatingJobId: 'job' };
const modelEvent = { jobId: 'job', taskId: 'task', type: 'model.execution', data: { toolCalls: ['request_hire'] } };
test('recruitment rejects operator-seeded and uncorrelated descendants', () => {
  assert.doesNotThrow(() => assertRecruit(hire, 'manager', 'task', [modelEvent]));
  assert.throws(() => assertRecruit({ ...hire, requestedBy: { kind: 'human', id: 'manager' } }, 'manager', 'task', [modelEvent]));
  assert.throws(() => assertRecruit(hire, 'manager', 'another-task', [modelEvent]));
  assert.throws(() => assertRecruit(hire, 'manager', 'task', [{ ...modelEvent, jobId: 'unrelated' }]));
  assert.throws(() => assertRecruit(hire, 'manager', 'task', [{ ...modelEvent, data: { toolCalls: [] } }]));
});
test('completion cannot substitute status or synthetic zero token usage for execution', () => {
  const task = { id: 'task', status: 'COMPLETED', evidence: { artifactIds: ['artifact'], eventIds: ['event'], jobId: 'job' } };
  const usage = { jobId: 'job', status: 'SETTLED', modelCalls: 1, inputTokens: 30, outputTokens: 10 };
  assert.doesNotThrow(() => assertTask(task, [modelEvent], [usage]));
  assert.throws(() => assertTask(task, [], [usage]));
  assert.throws(() => assertTask(task, [modelEvent], [{ ...usage, inputTokens: 0 }]));
  assert.throws(() => assertTask(task, [modelEvent], [{ ...usage, status: 'RESERVED' }]));
  assert.throws(() => assertTask({ ...task, evidence: { ...task.evidence, artifactIds: [] } }, [modelEvent], [usage]));
});
test('artifact byte changes alter evidence digests', () => {
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.notEqual(sha256('abc'), sha256('abd'));
});
