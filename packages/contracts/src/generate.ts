import { writeFile } from 'node:fs/promises';
import { CONTRACT_VERSION, openApi } from './index.js';
import { routeFixtures, emptyStates, errorFixtures, workerJobFixtures, jobOutcomes } from './fixtures.js';
await writeFile(new URL('../openapi.json',import.meta.url),JSON.stringify(openApi(),null,2)+'\n');
await writeFile(new URL('../fixtures.json',import.meta.url),JSON.stringify({contractVersion:CONTRACT_VERSION,notice:'Synthetic contract examples; not evidence of operational employees or completed real verification.',routes:routeFixtures,emptyStates,errors:errorFixtures,workerJobs:workerJobFixtures,workerOutcomes:jobOutcomes,idleClaim:{data:null}},null,2)+'\n');
