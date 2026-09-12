/** Readiness probe only. This is deliberately not the live acceptance gate. */
import assert from 'node:assert/strict';
const origin = process.env.E2E_API_ORIGIN;
const token = process.env.E2E_OPERATOR_TOKEN;
if (!origin || !token) {
  console.error('BLOCKED: set E2E_API_ORIGIN and E2E_OPERATOR_TOKEN. This smoke probe has no fixture fallback.');
  process.exitCode = 2;
} else {
  const call = async path => { const response = await fetch(new URL(path, origin), { headers: { cookie: await loginCookie } }); const body = await response.json().catch(() => null); assert.ok(response.ok, `${path}: ${body?.error?.message ?? response.status}`); return body; };
  const login = await fetch(new URL('/v1/session', origin), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  const loginCookie = login.headers.get('set-cookie');
  assert.ok(login.ok && loginCookie, 'login must issue an operator session cookie');
  const [organization, agents] = await Promise.all([call('/v1/organization'), call('/v1/agents')]);
  assert.ok(organization.data.organization.id && Array.isArray(agents.data), 'authoritative organization and agents must be reachable');
  console.log(`READY: ${organization.data.organization.id}; ${agents.data.length} agents. This is a smoke probe, not live acceptance.`);
}
