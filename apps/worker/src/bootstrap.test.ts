import test from 'node:test';
import assert from 'node:assert/strict';
test('shared contract is available; lane implementation is not installed', async () => {
  const contracts = await import('@agent-factory/contracts');
  assert.ok(contracts);
});
