import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspect } from './inspect.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'factory-ci-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, content = '// fixture\n') => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), typeof content === 'object' ? JSON.stringify(content) : content); };
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const commit = () => { git('add', '.'); git('-c', 'user.name=CI Test', '-c', 'user.email=ci@example.invalid', 'commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  const initialize = () => { git('init', '-q'); put('README.md'); return commit(); };
  return { root, put, git, commit, initialize };
}
function core(f) {
  f.put('package.json', { packageManager: 'pnpm@11.19.0', engines: { node: '24.20.0' }, scripts: { 'check:core': 'check', 'test:core': 'test', 'check:combined': 'combined', 'verify:live': 'live' } });
  for (const path of ['apps/api/package.json', 'db/package.json', 'packages/contracts/package.json']) f.put(path, {});
  for (const path of ['apps/api/src/server.ts', 'db/src/index.ts', 'packages/contracts/src/index.ts', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'apps/api/test/api.test.ts', 'db/test/db.test.ts', 'packages/contracts/test/contracts.test.ts']) f.put(path);
}
function lane(f, name) {
  f.put(`apps/${name}/package.json`, { scripts: { check: 'check', test: 'test', build: 'build' } });
  f.put(`apps/${name}/src/${name === 'worker' ? 'index.ts' : 'main.tsx'}`);
  f.put(`apps/${name}/src/behavior.test.ts`);
  f.put(`apps/${name}/Dockerfile`);
}

test('pipeline-only baseline does not pretend application delivery', t => {
  const f = fixture(t); f.put('.github/workflows/ci.yml'); f.put('scripts/ci/inspect.mjs');
  const result = inspect(f);
  assert.equal(result.application, false); assert.equal(result.core, false); assert.equal(result.full_system, false); assert.deepEqual(result.blockers, []);
  assert.ok(inspect({ ...f, requireSystem: true }).blockers.length > 0);
});
test('legacy runtime and root mockup fail instead of receiving green delivery', t => {
  const f = fixture(t); f.put('agent_factory/runtime.py'); f.put('app.js');
  const result = inspect(f);
  assert.equal(result.application, true); assert.match(result.blockers.join('\n'), /Legacy agent_factory/); assert.match(result.blockers.join('\n'), /Root app.js/);
});
test('core PR accepts reserved sibling scaffold, without enabling those lanes', t => {
  const f = fixture(t); core(f);
  for (const name of ['worker', 'web']) { f.put(`apps/${name}/package.json`, {}); f.put(`apps/${name}/src/bootstrap.test.ts`); }
  const result = inspect(f);
  assert.equal(result.core, true); assert.equal(result.worker, false); assert.equal(result.web, false); assert.deepEqual(result.blockers, []);
});
test('substantive worker edit with only bootstrap tests fails', t => {
  const f = fixture(t); core(f); f.put('apps/worker/package.json', { scripts: { check: 'check', test: 'test' } }); f.put('apps/worker/src/index.ts'); f.put('apps/worker/src/bootstrap.test.ts');
  assert.match(inspect(f).blockers.join('\n'), /non-bootstrap tests/);
});
test('base diff selects runtime change and still runs existing core checks', t => {
  const f = fixture(t); f.initialize(); core(f); const baseRef = f.commit(); lane(f, 'worker'); f.commit();
  const result = inspect({ ...f, baseRef });
  assert.equal(result.core, true); assert.equal(result.worker, true); assert.equal(result.application, true); assert.deepEqual(result.blockers, []); assert.ok(result.changedFiles.every(path => path.startsWith('apps/worker/')));
});
test('dedicated scaffold-only lane edit is blocked', t => {
  const f = fixture(t); f.initialize(); core(f); const baseRef = f.commit(); f.put('apps/web/src/bootstrap.test.ts'); f.commit();
  assert.match(inspect({ ...f, baseRef }).blockers.join('\n'), /reserved scaffold/);
});
test('complete structural prerequisites enable full system, not runtime proof', t => {
  const f = fixture(t); core(f); lane(f, 'worker'); lane(f, 'web'); f.put('tests/e2e/live.spec.ts');
  const result = inspect({ ...f, requireSystem: true });
  assert.equal(result.full_system, true); assert.deepEqual(result.blockers, []);
  rmSync(join(f.root, 'apps/worker/Dockerfile'));
  assert.match(inspect({ ...f, requireSystem: true }).blockers.join('\n'), /apps\/worker\/Dockerfile/);
});
test('deleted entrypoint is detected against base', t => {
  const f = fixture(t); f.initialize(); core(f); lane(f, 'worker'); const baseRef = f.commit(); rmSync(join(f.root, 'apps/worker/src/index.ts')); f.commit();
  assert.match(inspect({ ...f, baseRef }).blockers.join('\n'), /Worker changes require/);
});
test('application workspace enforces exact toolchain pins', t => {
  const f = fixture(t); core(f); const path = join(f.root, 'package.json'); const value = JSON.parse(readFileSync(path)); value.engines.node = '>=24'; writeFileSync(path, JSON.stringify(value));
  assert.match(inspect(f).blockers.join('\n'), /exact Node 24/);
});
test('actual CLI emits JSON and GitHub booleans and fails required delivery', t => {
  const f = fixture(t); f.put('README.md'); const output = join(f.root, 'github-output');
  const cli = fileURLToPath(new URL('./inspect.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, '--root', f.root], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: output } });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).full_system, false); assert.match(readFileSync(output, 'utf8'), /^core=false\nworker=false\nweb=false\napplication=false\nfull_system=false\n$/);
  const blocked = spawnSync(process.execPath, [cli, '--root', f.root, '--require-system'], { encoding: 'utf8' });
  assert.equal(blocked.status, 1); assert.match(blocked.stderr, /Full-system delivery unavailable/);
  assert.equal(spawnSync(process.execPath, [cli, '--unknown']).status, 1);
});
