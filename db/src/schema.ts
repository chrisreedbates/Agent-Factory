/** Table identifiers are never accepted from client input. */
export const tables = [
  'organizations', 'teams', 'principals', 'agents', 'manifests',
  'hiring_requests', 'approvals', 'jobs', 'tasks', 'schedules', 'messages',
  'escalations', 'grants', 'memory_entries', 'learning_proposals',
  'evaluations', 'usage_reservations', 'artifacts', 'events', 'idempotency_keys', 'resources', 'governance',
] as const;

export type TableName = typeof tables[number];
export function isTableName(value: string): value is TableName {
  return (tables as readonly string[]).includes(value);
}

/** Minimal SQL interface shared by pg and the PostgreSQL WASM integration harness. */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}
