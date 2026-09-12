import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiAdapter } from '../src/model.js';

test('provider adapter preserves finite nonnegative cost and leaves unknown or invalid cost null', async t => {
  const cases: Array<{ label: string; usage: unknown; expected: number | null }> = [
    { label: 'free call', usage: { cost: 0 }, expected: 0 },
    { label: 'paid call', usage: { cost: 0.00042 }, expected: 0.00042 },
    { label: 'missing usage', usage: undefined, expected: null },
    { label: 'missing cost', usage: {}, expected: null },
    { label: 'null cost', usage: { cost: null }, expected: null },
    { label: 'string cost', usage: { cost: '0.001' }, expected: null },
    { label: 'negative cost', usage: { cost: -0.01 }, expected: null },
    { label: 'NaN cost', usage: { cost: NaN }, expected: null },
    { label: 'infinite cost', usage: { cost: Infinity }, expected: null },
  ];
  for (const { label, usage, expected } of cases) {
    await t.test(label, async () => {
      const adapter = new OpenAiAdapter({ apiKey: null, baseURL: null, model: 'test-model' });
      // Inject an SDK double without credentials or provider traffic, preserving
      // non-JSON values to exercise validation of every SDK response shape.
      Object.assign(adapter, { client: { chat: { completions: { create: async () => ({
        choices: [{ message: { content: 'done' } }], usage,
      }) } } } });
      const turn = await adapter.turn({ system: 'Test', messages: [] });
      assert.equal(turn.usage.cost, expected);
      assert.equal(turn.usage.modelCalls, 1);
      assert.equal(turn.content, 'done');
    });
  }
});
