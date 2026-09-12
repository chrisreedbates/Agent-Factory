import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../../apps/web/src/api.ts', import.meta.url), 'utf8');
test('console calls Contract 1.1 operator routes and protects mutations', () => {
  for (const route of ['/v1/organization','/v1/agents','/v1/hiring-requests','/v1/tasks','/v1/messages','/v1/escalations','/v1/governance','/v1/memory','/v1/evaluations','/v1/usage','/v1/events','/v1/resources','/lifecycle']) assert.match(source, new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(source, /idempotency-key/);
  assert.match(source, /credentials: 'include'/);
});
