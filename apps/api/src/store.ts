import { randomUUID, createHash } from 'node:crypto';
import { type Queryable, type TableName } from '@agent-factory/db';
import { DomainError } from './domain.js';
export type RecordData = Record<string, any>;
export type Actor = { id: string; kind: string; organizationId: string; job?: RecordData };
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const principal = (a: Actor) => ({ id: a.id, kind: a.kind, organizationId: a.organizationId });
export class Store {
  constructor(public db: Queryable, public organizationId: string, public now: () => Date = () => new Date()) {}
  timestamp() { return this.now().toISOString(); }
  normalize(row: any): RecordData { return { ...row.data, id: row.id, organizationId: row.org_id, version: row.version, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() }; }
  async maybe(table: TableName, id: string): Promise<RecordData | null> {
    const { rows } = await this.db.query(`SELECT * FROM ${table} WHERE org_id=$1 AND id=$2`, [this.organizationId, id]);
    return rows[0] ? this.normalize(rows[0]) : null;
  }
  async get(table: TableName, id: string): Promise<RecordData> {
    const row = await this.maybe(table, id);
    if (!row) throw new DomainError('NOT_FOUND', 'The requested record does not exist in this organization', 404);
    return row;
  }
  async list(table: TableName): Promise<RecordData[]> {
    const { rows } = await this.db.query(`SELECT * FROM ${table} WHERE org_id=$1 ORDER BY created_at,id`, [this.organizationId]);
    return rows.map(row => this.normalize(row));
  }
  async insert(table: TableName, data: RecordData, id: string = randomUUID()): Promise<RecordData> {
    const time = this.timestamp();
    const value = { ...data, id, organizationId: this.organizationId, version: data.version ?? 1, createdAt: time, updatedAt: time };
    await this.db.query(`INSERT INTO ${table}(id,org_id,version,data,created_at,updated_at) VALUES($1,$2,$3,$4::jsonb,$5,$5)`, [id, this.organizationId, value.version, JSON.stringify(value), time]);
    return value;
  }
  async save(table: TableName, data: RecordData): Promise<RecordData> {
    const updated = { ...data, version: data.version + 1, updatedAt: this.timestamp() };
    const result = await this.db.query(`UPDATE ${table} SET data=$1::jsonb, version=$2, updated_at=$3 WHERE id=$4 AND org_id=$5 AND version=$6 RETURNING *`, [JSON.stringify(updated), updated.version, updated.updatedAt, data.id, this.organizationId, data.version]);
    if (!result.rows.length) throw new DomainError('VERSION_CONFLICT', 'Record changed; reload its current version');
    return this.normalize(result.rows[0]);
  }
  async event(type: string, message: string, context: RecordData = {}, data: RecordData = {}) {
    const org = await this.get('organizations', this.organizationId);
    return this.insert('events', { agentId: context.agentId ?? null, taskId: context.taskId ?? null, jobId: context.jobId ?? context.job?.id ?? null, attempt: context.attempt ?? context.job?.attempt ?? null, metaAgentId: org.metaAgentId, hiringRequestId: context.hiringRequestId ?? null, correlationId: context.correlationId ?? randomUUID(), type, message, data, executedBy: context.executedBy ?? null });
  }
}
export function expected(row: RecordData, version: number) { if (row.version !== version) throw new DomainError('VERSION_CONFLICT', 'Record changed; reload its current version'); }
/** A connection-level mutex prevents overlapping transactions on a supplied single connection. PostgreSQL also locks the organization row across API processes. */
const queues = new WeakMap<object, Promise<unknown>>();
export async function transaction<T>(db: Queryable, organizationId: string, fn: (store: Store) => Promise<T>, now?: () => Date): Promise<T> {
  const before = queues.get(db as object) ?? Promise.resolve();
  const next = before.catch(() => {}).then(async () => {
    await db.query('BEGIN');
    try {
      const locked = await db.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [organizationId]);
      if (!locked.rows.length) throw new DomainError('NOT_FOUND', 'Organization is not initialized', 404);
      const value = await fn(new Store(db, organizationId, now));
      await db.query('COMMIT'); return value;
    } catch (e) { await db.query('ROLLBACK'); throw e; }
  });
  queues.set(db as object, next);
  return next;
}
