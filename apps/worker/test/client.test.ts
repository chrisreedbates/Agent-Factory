import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { ControlPlaneClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { makeAgent, makeJob } from './fakes.js';

interface SeenRequest { url: string; method: string; headers: Record<string, any>; body: any }

test('client sends fencing headers, idempotency keys and maps lease errors', async () => {
  const seen: SeenRequest[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    seen.push({ url: request.url ?? '', method: request.method ?? '', headers: request.headers, body: raw ? JSON.parse(raw) : null });
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/worker/jobs/claim') {
      response.end(JSON.stringify({ data: null }));
      return;
    }
    if (request.url?.endsWith('/fail')) {
      response.statusCode = 409;
      response.end(JSON.stringify({ error: { code: 'STALE_LEASE', message: 'stale lease', retryable: false, correlationId: 'c' } }));
      return;
    }
    response.end(JSON.stringify({ data: { id: 'ok' } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    const config = loadConfig({ WORKER_TOKEN: 't'.repeat(32), MODEL_NAME: 'test-model', API_BASE_URL: `http://127.0.0.1:${port}` } as NodeJS.ProcessEnv);
    const client = new ControlPlaneClient(config);
    const job = makeJob('run_task', { agent: makeAgent(), task: {}, inputMessage: null });

    assert.equal(await client.claim(['run_task'], 60), null);
    await client.appendEvent(job, { type: 'verification.client', message: 'hello', data: {} });
    await client.publishArtifact(job, { path: 'agent-1/job/1/x.txt', contentType: 'text/plain', size: 1, sha256: 'a'.repeat(64), scope: { visibility: 'private', teamId: null, agentIds: [] } });
    await client.asAgent(job, 'createMemory', '/v1/memory', { ownerAgentId: 'agent-1' });
    await assert.rejects(
      () => client.fail(job, { code: 'X', message: 'y', retryable: false, evidence: null }),
      (error: any) => error.name === 'LeaseLostError',
    );

    const claim = seen.find(entry => entry.url === '/v1/worker/jobs/claim')!;
    assert.match(claim.headers.authorization, /^Bearer t+$/);
    assert.equal(claim.headers['idempotency-key'], undefined);

    const eventRequest = seen.find(entry => entry.url.includes('/events'))!;
    assert.ok(eventRequest.headers['idempotency-key'], 'mutations must be idempotent');
    assert.equal(eventRequest.body.leaseToken, job.leaseToken);
    assert.equal(eventRequest.body.attempt, job.attempt);

    const memoryRequest = seen.find(entry => entry.url === '/v1/memory')!;
    assert.equal(memoryRequest.headers['x-job-id'], job.jobId);
    assert.equal(memoryRequest.headers['x-lease-token'], job.leaseToken);
    assert.equal(memoryRequest.headers['x-job-attempt'], String(job.attempt));

    // Replaying the identical mutation reuses one deterministic idempotency key.
    const firstKey = eventRequest.headers['idempotency-key'];
    await client.appendEvent(job, { type: 'verification.client', message: 'hello', data: {} });
    const keys = seen.filter(entry => entry.url.includes('/events')).map(entry => entry.headers['idempotency-key']);
    assert.equal(keys[0], firstKey);
    assert.equal(keys[0], keys[1]);
  } finally {
    server.close();
    await once(server, 'close').catch(() => {});
  }
});
