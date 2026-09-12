import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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

test('workspace memory reads back verbatim and is agent scoped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-worker-memory-'));
  try {
    const workspace = new Workspace(join(root, 'artifacts'), join(root, 'sources'));
    await workspace.writeWorkspaceFile('agent-1', 'memory/working.json', '{"a":1}');
    assert.equal(await workspace.read('workspace', 'agent-1', 'memory/working.json'), '{"a":1}');
    await assert.rejects(() => workspace.read('workspace', 'agent-2', 'memory/working.json'), /Cannot read workspace/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
