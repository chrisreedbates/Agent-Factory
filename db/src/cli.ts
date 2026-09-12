import { connect, migrate, seed } from './index.js';

const command = process.argv[2];
if (command !== 'migrate' && command !== 'seed') throw new Error('Usage: tsx db/src/cli.ts migrate|seed');
const pool = connect();
const client = await pool.connect();
try {
  console.log({ migrations: await migrate(client) });
  if (command === 'seed') {
    await seed(client);
    console.log('Development organization and coordinator initialized; no employees or evidence seeded.');
  }
} finally {
  client.release();
  await pool.end();
}
