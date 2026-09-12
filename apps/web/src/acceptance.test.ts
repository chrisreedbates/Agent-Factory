import test from 'node:test';import assert from 'node:assert/strict';
test('operator console has no production fixture endpoint',async()=>{const source=await import('node:fs/promises').then(fs=>fs.readFile(new URL('./main.tsx',import.meta.url),'utf8'));assert.doesNotMatch(source,/Maya Chen|Visual Content Agent|setTimeout/)});
