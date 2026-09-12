import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { Value } from '@sinclair/typebox/value';
import { Organization, Team, FactoryCoordinator, Memory } from '@agent-factory/contracts';
import { migrate, seed, seedIds, tables, type Queryable } from '../src/index.js';

function adapter(pg: PGlite): Queryable {
  return {
    async query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> {
      if (values?.length) return pg.query<T>(sql, values);
      const results = await pg.exec(sql);
      return { rows: (results.at(-1)?.rows ?? []) as T[] };
    },
  };
}

test('migrations and development seed are repeatable and do not fabricate employees or evidence', async () => {
  const pg = new PGlite();
  const db = adapter(pg);
  try {
    assert.deepEqual(await migrate(db), ['001_control_plane.sql']);
    assert.deepEqual(await migrate(db), []);
    await seed(db);
    await seed(db);
    for (const table of tables) {
      const rows = await pg.query<{ count: number }>(`SELECT count(*)::integer AS count FROM ${table}`);
      const expected = table === 'organizations' || table === 'memory_entries' ? 1 : table === 'principals' ? 3 : table === 'teams' ? 2 : 0;
      assert.equal(rows.rows[0]?.count, expected, table);
    }
    const principal = await pg.query<{ data: { kind: string } }>('SELECT data FROM principals WHERE id = $1', [seedIds.coordinator]);
    assert.equal(principal.rows[0]?.data.kind, 'factory');
    for (const [table, schema, id] of [
      ['organizations', Organization, seedIds.organization],
      ['teams', Team, seedIds.researchTeam],
      ['principals', FactoryCoordinator, seedIds.coordinator],
      ['memory_entries', Memory, 'standards-demo-v1'],
    ] as const) {
      const result = await pg.query<{ id: string; org_id: string; version: number; data: Record<string, unknown>; created_at: Date; updated_at: Date }>(`SELECT * FROM ${table} WHERE id=$1`, [id]);
      const row = result.rows[0]!;
      const document = { ...row.data, id: row.id, organizationId: row.org_id, version: row.version,
        createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
      assert.equal(Value.Check(schema, document), true, JSON.stringify([...Value.Errors(schema, document)]));
    }
  } finally { await pg.close(); }
});

test('database survives restart with all domain records retained', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-factory-db-'));
  let pg = new PGlite(directory);
  try {
    await migrate(adapter(pg));
    await seed(adapter(pg));
    for (const table of ['agents', 'manifests', 'approvals', 'tasks', 'messages', 'usage_reservations', 'events'] as const) {
      await pg.query(`INSERT INTO ${table} (id, org_id, data) VALUES ($1, $2, $3)`,
        [`restart-${table}`, seedIds.organization, JSON.stringify({ fixture: true, agentId: 'restart-agents', version: 1 })]);
    }
    await pg.close();
    pg = new PGlite(directory);
    assert.deepEqual(await migrate(adapter(pg)), []);
    for (const table of ['agents', 'manifests', 'approvals', 'tasks', 'messages', 'usage_reservations', 'events'] as const) {
      const result = await pg.query<{ data: { fixture: boolean } }>(`SELECT data FROM ${table} WHERE id = $1`, [`restart-${table}`]);
      assert.equal(result.rows[0]?.data.fixture, true, `${table} survives database close and reopen`);
    }
  } finally {
    await pg.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('tenant references, document shape, revision and idempotency are enforced by PostgreSQL', async () => {
  const pg = new PGlite();
  try {
    await migrate(adapter(pg));
    await seed(adapter(pg));
    await assert.rejects(pg.query("INSERT INTO tasks (id, org_id, data) VALUES ('orphan', 'missing', '{}')"), /foreign key/);
    await assert.rejects(pg.query("INSERT INTO tasks (id, org_id, data) VALUES ('array', 'org-demo', '[]')"), /check constraint/);
    await assert.rejects(pg.query("INSERT INTO tasks (id, org_id, version, data) VALUES ('bad-version', 'org-demo', 0, '{}')"), /check constraint/);
    await pg.query(`INSERT INTO jobs (id, org_id, data) VALUES ('job-a', 'org-demo', '{"idempotencyKey":"same-key"}')`);
    await assert.rejects(pg.query(`INSERT INTO jobs (id, org_id, data) VALUES ('job-b', 'org-demo', '{"idempotencyKey":"same-key"}')`), /unique constraint/);
    await pg.query(`INSERT INTO manifests (id, org_id, data) VALUES ('manifest-a', 'org-demo', '{"agentId":"agent-a","version":1}')`);
    await assert.rejects(pg.query(`INSERT INTO manifests (id, org_id, data) VALUES ('manifest-b', 'org-demo', '{"agentId":"agent-a","version":1}')`), /unique constraint/);
    for (const table of ['manifests', 'events', 'artifacts'] as const) {
      if (table !== 'manifests') await pg.query(`INSERT INTO ${table} (id, org_id, data) VALUES ($1, 'org-demo', '{}')`, [table]);
      await assert.rejects(pg.query(`UPDATE ${table} SET data = '{}'`), /immutable/);
      await assert.rejects(pg.query(`DELETE FROM ${table}`), /immutable/);
    }
  } finally { await pg.close(); }
});

test('migration checksum mismatch fails atomically', async () => {
  const pg = new PGlite();
  try {
    await migrate(adapter(pg));
    await pg.query("UPDATE schema_migrations SET checksum = 'tampered'");
    await assert.rejects(migrate(adapter(pg)), /Applied migration was modified/);
    // A failed migration leaves a usable connection rather than an open failed transaction.
    const result = await pg.query<{ value: number }>('SELECT 1 AS value');
    assert.equal(result.rows[0]?.value, 1);
  } finally { await pg.close(); }
});
