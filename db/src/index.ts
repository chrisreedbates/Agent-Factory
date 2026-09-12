import pg from 'pg';
export * from './schema.js';
export { migrate } from './migrate.js';
export { seed, seedIds } from './seed.js';

export function connect(connectionString = process.env.DATABASE_URL): pg.Pool {
  if (!connectionString) throw new Error('DATABASE_URL must be configured');
  return new pg.Pool({ connectionString, max: 10 });
}
