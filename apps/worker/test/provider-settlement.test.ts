import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { JobRunner } from '../src/handlers.js';
import { OpenAiAdapter, ModelCallError } from '../src/model.js';
import { WorkerRuntime } from '../src/runtime.js';
import { Workspace } from '../src/workspace.js';
import { FakeControlPlane, makeAgent, makeJob, makeManifest } from './fakes.js';

const cases = [
  { label: 'string status code', response: { error: { code: '503' } }, retryable: true },
  { label: 'in-band overload', response: { error: { code: 503 } }, retryable: true },
  { label: 'in-band authentication', response: { error: { code: 401 } }, retryable: false },
  { label: 'in-band model config', response: { error: { type: 'invalid_request_error', code: 'model_not_found' } }, retryable: false },
  { label: 'quota is permanent despite 429', response: { error: { status: 429, code: 'insufficient_quota' } }, retryable: false },
  { label: 'unclassified error', response: { error: { message: 'Unknown' } }, retryable: false },
  { label: 'thrown HTTP rate limit', thrown: { status: 429 }, retryable: true },
  { label: 'thrown HTTP auth', thrown: { status: 403 }, retryable: false },
  { label: 'SDK network', thrown: { name: 'APIConnectionError' }, retryable: true },
  { label: 'SDK timeout', thrown: { name: 'APIConnectionTimeoutError' }, retryable: true },
  { label: 'network reset code', thrown: { code: 'ECONNRESET' }, retryable: true },
  { label: 'arbitrary thrown error', thrown: { name: 'TypeError' }, retryable: false },
];

test('adapter failures settle dispatched calls and reported usage through the real runner/runtime', async t => {
  for (const example of cases) await t.test(example.label, async () => {
    const root = await mkdtemp(join(tmpdir(), 'provider-settlement-'));
    try {
      const config = loadConfig({ WORKER_TOKEN: 't'.repeat(32), MODEL_NAME: 'test-model',
        ARTIFACT_ROOT: join(root, 'artifacts'), SOURCE_ROOT: join(root, 'sources') });
      const client = new FakeControlPlane();
      let settled: Record<string, unknown> | undefined;
      const settle = client.settleBudget.bind(client);
      client.settleBudget = async (job, input) => { settled = { ...input }; return settle(job, input); };
      const model = new OpenAiAdapter({ apiKey: null, baseURL: null, model: 'test-model' });
      const usage = { prompt_tokens: 21, completion_tokens: 3, cost: 0.002 };
      Object.assign(model, { client: { chat: { completions: { create: async () => {
        if (example.thrown) throw Object.assign(new Error('Provider failure'), example.thrown, { usage });
        return { ...example.response, usage };
      } } } } });
      const runner = new JobRunner({ config, client, model, workspace: new Workspace(config.artifactRoot, config.sourceRoot), log: () => {} });
      const runtime = new WorkerRuntime({ config, client, runner, log: () => {}, enableRenewal: false });
      client.queue.push(makeJob('provision_agent', { agent: makeAgent({ status: 'PROVISIONING' }), manifest: makeManifest(), manifestVersion: 1 }));
      await runtime.runOnce();
      assert.equal(client.failed.length, 1);
      assert.equal(client.failed[0].code, 'MODEL_CALL_FAILED');
      assert.equal(client.failed[0].retryable, example.retryable);
      assert.equal(settled?.modelCalls, 1);
      assert.equal(settled?.inputTokens, 21);
      assert.equal(settled?.outputTokens, 3);
      assert.equal(settled?.cost, 0.002);
      assert.ok(client.ops.indexOf('settleBudget') < client.ops.indexOf('failJob'));
      assert.equal(client.completed.length, 0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

test('token counts are finite nonnegative integers on success and failure', async t => {
  for (const count of [-1, 0.5, NaN, Infinity, '12', null, undefined, 0, 12]) {
    await t.test(String(count), async () => {
      const expected = typeof count === 'number' && Number.isFinite(count) && Number.isInteger(count) && count >= 0 ? count : null;
      for (const failed of [false, true]) {
        const model = new OpenAiAdapter({ apiKey: null, baseURL: null, model: 'test-model' });
        Object.assign(model, { client: { chat: { completions: { create: async () => ({
          ...(failed ? { error: { code: 503 } } : { choices: [{ message: { content: 'ok' } }] }),
          usage: { prompt_tokens: count, completion_tokens: count, cost: -1 },
        }) } } } });
        const result = await model.turn({ system: 'Test', messages: [] }).catch(error => {
          assert.ok(error instanceof ModelCallError); return error;
        });
        assert.equal(result.usage.modelCalls, 1);
        assert.equal(result.usage.inputTokens, expected);
        assert.equal(result.usage.outputTokens, expected);
        assert.equal(result.usage.cost, null);
      }
    });
  }
});


test('missing local credentials are nonretryable and have no dispatched-call usage', async () => {
  const model = new OpenAiAdapter({ apiKey: null, baseURL: null, model: 'test-model' });
  await assert.rejects(model.turn({ system: 'Test', messages: [] }), (error: any) => {
    assert.equal(error.code, 'MODEL_UNAVAILABLE');
    assert.equal(error.retryable, false);
    assert.equal(error.usage, undefined);
    return true;
  });
});

test('a thrown provider attempt without usage still records one model call', async () => {
  const model = new OpenAiAdapter({ apiKey: null, baseURL: null, model: 'test-model' });
  Object.assign(model, { client: { chat: { completions: { create: async () => { throw Object.assign(new Error('timeout'), { name: 'APIConnectionTimeoutError' }); } } } } });
  await assert.rejects(model.turn({ system: 'Test', messages: [] }), (error: any) => {
    assert.deepEqual(error.usage, { modelCalls: 1, inputTokens: null, outputTokens: null, cost: null });
    return true;
  });
});
