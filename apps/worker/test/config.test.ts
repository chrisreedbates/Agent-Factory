import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('loadConfig rejects missing credentials and an unset model', () => {
  assert.throws(() => loadConfig({ MODEL_NAME: 'gpt-test' } as NodeJS.ProcessEnv), /WORKER_TOKEN/);
  assert.throws(() => loadConfig({ WORKER_TOKEN: 'x'.repeat(32) } as NodeJS.ProcessEnv), /MODEL_NAME/);
});

test('loadConfig applies contract-safe defaults and parses job kinds', () => {
  const config = loadConfig({ WORKER_TOKEN: 'x'.repeat(32), MODEL_NAME: 'gpt-test' } as NodeJS.ProcessEnv);
  assert.equal(config.jobKinds.length, 6);
  assert.equal(config.currency, 'USD');
  assert.ok(config.leaseSeconds >= 10 && config.leaseSeconds <= 300);
  const narrowed = loadConfig({ WORKER_TOKEN: 'x'.repeat(32), MODEL_NAME: 'gpt-test', WORKER_JOB_KINDS: 'run_task, learn' } as NodeJS.ProcessEnv);
  assert.deepEqual(narrowed.jobKinds, ['run_task', 'learn']);
  assert.throws(
    () => loadConfig({ WORKER_TOKEN: 'x'.repeat(32), MODEL_NAME: 'gpt-test', WORKER_JOB_KINDS: 'not_a_kind' } as NodeJS.ProcessEnv),
    /WORKER_JOB_KINDS/,
  );
});
