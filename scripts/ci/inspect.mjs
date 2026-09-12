#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function filesAt(root, directory = '') {
  if (!existsSync(resolve(root, directory))) return [];
  return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap(entry => {
    if (['.git', 'node_modules', 'dist', 'coverage'].includes(entry.name) || entry.isSymbolicLink()) return [];
    const path = directory ? `${directory}/${entry.name}` : entry.name;
    return entry.isDirectory() ? filesAt(root, path) : [path];
  });
}

/** Select executable CI lanes. File presence is not behavioral verification. */
export function inspect({ root = process.cwd(), baseRef, requireSystem = false } = {}) {
  root = resolve(root);
  const files = filesAt(root);
  const has = path => files.includes(path);
  const readPackage = path => {
    if (!has(path)) return {};
    try { return JSON.parse(readFileSync(resolve(root, path), 'utf8')); }
    catch { return {}; }
  };
  const changedFiles = baseRef
    ? execFileSync('git', ['diff', '--name-only', '-z', `${baseRef}...HEAD`, '--'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
    : files;
  const rootPackage = readPackage('package.json');
  const blockers = [];
  const prerequisites = [];
  const coreTouched = changedFiles.some(path => /^(apps\/api\/|db\/|packages\/contracts\/|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|\.npmrc$|\.node-version$|tsconfig\.base\.json$|Dockerfile$|compose\.ya?ml$)/.test(path));
  const laneTouched = lane => {
    const paths = changedFiles.filter(path => path.startsWith(`apps/${lane}/`));
    // Core owns the shared package/lockfile scaffold; it does not claim sibling delivery.
    return paths.some(path => !/^apps\/(worker|web)\/(package\.json|tsconfig\.json|src\/bootstrap\.test\.ts)$/.test(path)) || (paths.length > 0 && !coreTouched);
  };
  const legacy = changedFiles.some(path => has(path) && /^agent_factory\//.test(path));
  const rootUI = changedFiles.some(path => has(path) && /^(app\.js|index\.html|styles\.css)$/.test(path));
  const workerTouched = laneTouched('worker') || legacy;
  const webTouched = laneTouched('web') || rootUI || changedFiles.some(path => path.startsWith('tests/e2e/'));
  const application = coreTouched || workerTouched || webTouched;
  const hasTests = prefix => files.some(path => path.startsWith(prefix) && /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) && !path.endsWith('/bootstrap.test.ts'));
  const lane = (name, entry) => has(`apps/${name}/package.json`) && has(entry)
    && Boolean(readPackage(`apps/${name}/package.json`).scripts?.check)
    && Boolean(readPackage(`apps/${name}/package.json`).scripts?.test)
    && hasTests(`apps/${name}/`);
  const core = ['apps/api/package.json', 'db/package.json', 'packages/contracts/package.json', 'apps/api/src/server.ts', 'db/src/index.ts', 'packages/contracts/src/index.ts', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].every(has)
    && Boolean(rootPackage.scripts?.['check:core']) && Boolean(rootPackage.scripts?.['test:core'])
    && ['apps/api/', 'db/', 'packages/contracts/'].every(hasTests);
  const worker = lane('worker', 'apps/worker/src/index.ts');
  const web = lane('web', 'apps/web/src/main.tsx') && Boolean(readPackage('apps/web/package.json').scripts?.build);
  if (legacy) blockers.push('Legacy agent_factory runtime changes are incompatible with the shared TypeScript worker contract; port them to apps/worker.');
  if (rootUI) blockers.push('Root app.js/index.html/styles.css console changes are unsupported; implement the authoritative API console in apps/web, with fixtures confined to explicit tests.');
  if (coreTouched && !core) blockers.push('Core application changes require the shared API/database/contracts workspace, lane tests, frozen lockfile and check:core/test:core scripts.');
  if (workerTouched && !worker) blockers.push('Worker changes require apps/worker/src/index.ts, package check/test scripts and non-bootstrap tests; reserved scaffold cannot pass as runtime implementation.');
  if (webTouched && !web) blockers.push('Console changes require apps/web/src/main.tsx, package check/test/build scripts and non-bootstrap tests; reserved scaffold cannot pass as a console.');
  if (application && core && (!/^pnpm@\d+\.\d+\.\d+(?:\+.*)?$/.test(rootPackage.packageManager ?? '') || !/^24\.\d+\.\d+$/.test(rootPackage.engines?.node ?? ''))) {
    blockers.push('Pin packageManager to an exact pnpm version and engines.node to an exact Node 24 version.');
  }
  if (!core) prerequisites.push('Runnable core workspace and its tests');
  if (!worker) prerequisites.push('Runnable apps/worker implementation and non-bootstrap tests');
  if (!web) prerequisites.push('Runnable apps/web implementation, build and non-bootstrap tests');
  if (!hasTests('tests/e2e/')) prerequisites.push('Executable tests/e2e acceptance tests');
  for (const script of ['check:combined', 'verify:live']) {
    if (!rootPackage.scripts?.[script]) prerequisites.push(`Root package script ${script}`);
  }
  for (const path of ['apps/worker/Dockerfile', 'apps/web/Dockerfile']) {
    if (!has(path)) prerequisites.push(path);
  }
  const full_system = prerequisites.length === 0 && blockers.length === 0;
  if (requireSystem) blockers.push(...prerequisites.map(item => `Full-system delivery unavailable: ${item}.`));
  return { core, worker, web, application, full_system, changedFiles, blockers, prerequisites };
}

export function main(args = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--require-system') options.requireSystem = true;
    else if (['--root', '--base-ref'].includes(args[i])) {
      const key = args[i] === '--root' ? 'root' : 'baseRef';
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${args[i]}`);
      options[key] = args[++i];
    } else throw new Error(`Unknown argument: ${args[i]}`);
  }
  const result = inspect(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, ['core', 'worker', 'web', 'application', 'full_system'].map(key => `${key}=${result[key]}\n`).join(''));
  }
  if (result.blockers.length) {
    process.stderr.write(`${result.blockers.join('\n')}\n`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = main(); }
  catch (error) { console.error(`CI layout inspection failed: ${error.message}`); process.exitCode = 1; }
}
