import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import type { Queryable } from './schema.js';

/** Caller supplies one dedicated connection, not a pool, for transaction affinity. */
export async function migrate(db: Queryable): Promise<string[]> {
  await db.query('BEGIN');
  try {
    // Transaction-scoped lock serializes startup against other migration runners.
    await db.query('SELECT pg_advisory_xact_lock(174021, 1)');
    await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await db.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations');
    const versions = new Map(applied.rows.map(row => [row.version, row.checksum]));
    const directory = new URL('../migrations/', import.meta.url);
    const files = (await readdir(directory)).filter(file => /^\d{3}_[a-z0-9_]+\.sql$/.test(file)).sort();
    const added: string[] = [];
    for (const file of files) {
      const sql = await readFile(new URL(file, directory), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      if (versions.has(file)) {
        if (versions.get(file) !== checksum) throw new Error(`Applied migration was modified: ${file}`);
        continue;
      }
      await db.query(sql);
      await db.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [file, checksum]);
      added.push(file);
    }
    await db.query('COMMIT');
    return added;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}
