import { existsSync } from 'node:fs';
const required = ['apps/worker/src/index.ts', 'apps/web/src/main.tsx', 'tests/e2e'];
const missing = required.filter(path => !existsSync(path));
if (missing.length) { console.error(`Combined system unavailable: missing ${missing.join(', ')}. Run check:core for the control-plane lane.`); process.exit(1); }
