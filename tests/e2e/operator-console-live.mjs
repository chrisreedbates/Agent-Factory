/**
 * Contract-level live verification. It intentionally requires a real control
 * plane and operator token; it never installs fixtures or treats an absent
 * runtime as success.
 */
import assert from 'node:assert/strict';

const origin = process.env.E2E_API_ORIGIN;
const token = process.env.E2E_OPERATOR_TOKEN;
if (!origin || !token) {
  console.error('BLOCKED: set E2E_API_ORIGIN and E2E_OPERATOR_TOKEN for live verification. No fixture fallback exists.');
  process.exitCode = 2;
} else {
  const call = async (path, init = {}) => {
    const response = await fetch(new URL(path, origin), { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
    const body = await response.json().catch(() => null);
    assert.ok(response.ok, `${path}: ${body?.error?.message ?? response.status}`);
    return { response, body };
  };
  const login = await call('/v1/session', { method: 'POST', body: JSON.stringify({ token }) });
  const cookie = login.response.headers.get('set-cookie');
  assert.ok(cookie, 'session login must issue an operator cookie');
  const headers = { cookie, 'idempotency-key': crypto.randomUUID() };
  const organization = await call('/v1/organization', { headers });
  assert.ok(organization.body.data.organization.id, 'organization detail is authoritative');
  const agents = await call('/v1/agents', { headers });
  assert.ok(Array.isArray(agents.body.data), 'agent list response has a data page');
  const [hires, tasks, messages, events, escalations, governance, memory, evaluations, usage] = await Promise.all(['/v1/hiring-requests','/v1/tasks','/v1/messages','/v1/events','/v1/escalations','/v1/governance','/v1/memory','/v1/evaluations','/v1/usage'].map(path => call(path, { headers })));
  for (const result of [hires, tasks, messages, events, escalations, governance, memory, evaluations, usage]) assert.ok(Array.isArray(result.body.data), 'operational list must return a data page');
  console.log(`PASS: live organization ${organization.body.data.organization.id}; ${agents.body.data.length} agents; operator views reachable.`);
}
