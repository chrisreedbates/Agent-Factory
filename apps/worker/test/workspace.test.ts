import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace, safeRelativePath } from '../src/workspace.js';

test('safeRelativePath rejects traversal, absolute and empty paths', () => {
  assert.throws(() => safeRelativePath('../etc/passwd'), /Unsafe path segment/);
  assert.throws(() => safeRelativePath(''), /relative/);
  assert.throws(() => safeRelativePath('/etc/passwd'), /relative/);
  assert.throws(() => safeRelativePath('reports/../../escape.md'), /Unsafe path segment/);
  assert.equal(safeRelativePath('reports/q1 summary.md'), 'reports/q1-summary.md');
});

test('job artifacts are immutable and probes round-trip', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-worker-workspace-'));
  try {
    const workspace = new Workspace(join(root, 'artifacts'), join(root, 'sources'));
    const stored = await workspace.probe('agent-1', 'job-1', 1, 'runtime-probe.txt', 'hello');
    assert.equal(stored.path, 'agent-1/job-1/1/runtime-probe.txt');
    assert.equal(stored.size, 5);
    assert.match(stored.sha256, /^[a-f0-9]{64}$/);
    await assert.rejects(
      () => workspace.writeArtifact('agent-1', 'job-1', 1, 'runtime-probe.txt', 'different'),
      /different bytes/,
    );
    // Identical content is accepted as the same immutable artifact.
    const again = await workspace.writeArtifact('agent-1', 'job-1', 1, 'runtime-probe.txt', 'hello');
    assert.equal(again.sha256, stored.sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a symlinked start directory cannot be enumerated through list', async t => {
  const root = await mkdtemp(join(tmpdir(), 'af-worker-symlink-'));
  try {
    const workspace = new Workspace(join(root, 'artifacts'), join(root, 'sources'));
    const briefs = join(root, 'sources', 'agent-1');
    await mkdir(briefs, { recursive: true });
    await writeFile(join(briefs, 'brief.md'), 'x');
    const outside = join(root, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'secret.md'), 'secret');
    try {
      await symlink(outside, join(briefs, 'link'), 'dir');
    } catch {
      t.skip('symbolic links are unavailable in this environment');
      return;
    }
    await assert.rejects(() => workspace.list('briefs', 'agent-1', 'link'), /Symbolic links/);
    await assert.rejects(() => workspace.read('briefs', 'agent-1', 'link/secret.md'), /Symbolic links/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workspace memory reads back verbatim and is agent scoped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-worker-memory-'));
  try {
    const workspace = new Workspace(join(root, 'artifacts'), join(root, 'sources'));
    await workspace.replaceAttemptFile('agent-1', 'job-1', 1, 'memory/working.json', '{"a":1}', () => {});
    assert.equal(await workspace.read('workspace', 'agent-1', 'memory/working.json'), '{"a":1}');
    await assert.rejects(() => workspace.read('workspace', 'agent-2', 'memory/working.json'), /Cannot read workspace/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an atomic attempt-guarded replacement refuses a stale attempt and a lost lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-worker-fence-'));
  try {
    const workspace = new Workspace(join(root, 'artifacts'), join(root, 'sources'));
    await workspace.replaceAttemptFile('agent-1', 'job-1', 2, 'memory/working.json', '{"attempt":2}', () => {});

    // A newer attempt owns this path; a stale attempt must not clobber it.
    await assert.rejects(
      () => workspace.replaceAttemptFile('agent-1', 'job-1', 1, 'memory/working.json', '{"attempt":1}', () => {}),
      /owned by attempt 2/,
    );
    // The lease assertion runs before the replacement, so a lost lease writes nothing.
    await assert.rejects(
      () => workspace.replaceAttemptFile('agent-1', 'job-1', 3, 'memory/working.json', '{"attempt":3}', () => { throw new Error('lease lost'); }),
      /lease lost/,
    );
    assert.equal(await workspace.read('workspace', 'agent-1', 'memory/working.json'), '{"attempt":2}');
    // No partial temp files are ever left behind.
    assert.deepEqual((await workspace.list('workspace', 'agent-1')).map(file => file.path), ['memory/working.json']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a real sibling agent on the volume is reported and its scope is unreachable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-worker-sibling-'));
  try {
    const workspace = new Workspace(join(root, 'artifacts'), join(root, 'sources'));
    await mkdir(join(root, 'sources', 'agent-1'), { recursive: true });
    await mkdir(join(root, 'sources', 'agent-2'), { recursive: true });
    await writeFile(join(root, 'sources', 'agent-2', 'brief.md'), 'sibling secret');

    assert.equal(await workspace.otherAgent('agent-1'), 'agent-2', 'the probe must find the real sibling');
    assert.equal(await workspace.otherAgent('agent-3'), 'agent-1');
    // Traversal into the sibling's scoped root is refused, so its data is unreachable.
    await assert.rejects(() => workspace.read('briefs', 'agent-1', '../agent-2/brief.md'), /Unsafe path segment/);
    await assert.rejects(() => workspace.list('briefs', 'agent-1', '../agent-2'), /Unsafe path segment/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
