import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readArtifact, MAX_ARTIFACT_BYTES } from '../src/artifacts.js';
import { DomainError } from '../src/domain.js';

const bytes = Buffer.from('# Evidence\nVerified source material.\n');
const metadata = {size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')};
const path = 'agent-one/job-one/1/report.md';
const errorCode = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;
async function fixture(t: {after(fn: () => Promise<unknown>): void}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'agent-factory-artifacts-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'agent-one/job-one/1'),{recursive:true});
  await writeFile(join(root,path),bytes);
  return root;
}

test('publication and later retrieval return the exact authorized bytes',async t=>{
  const root=await fixture(t);
  assert.deepEqual(await readArtifact(root,path,metadata,'agent-one/job-one/1'),bytes);
  assert.deepEqual(await readArtifact(root,path,metadata),bytes);
});

test('path traversal, absolute paths, Windows separators and empty segments are rejected',async t=>{
  const root=await fixture(t);
  for(const unsafe of ['../secret','agent-one/../../secret','/etc/passwd','C:\\secret','agent-one\\secret','agent-one//report.md','agent-one/./report.md','agent-one/job-one/1/report.md/','agent-one/%2e%2e/secret','agent-one/\0secret']) {
    await assert.rejects(readArtifact(root,unsafe,metadata),errorCode('INVALID_ARTIFACT_PATH'),unsafe);
  }
});

test('scope matching respects directory boundaries and attempt identity',async t=>{
  const root=await fixture(t);
  await assert.rejects(readArtifact(root,path,metadata,'agent-on'),errorCode('ARTIFACT_SCOPE_DENIED'));
  await assert.rejects(readArtifact(root,path,metadata,'agent-one/job-one/2'),errorCode('ARTIFACT_SCOPE_DENIED'));
  assert.deepEqual(await readArtifact(root,path,metadata,'agent-one/job-one/1/'),bytes);
});

test('both internal and escaping symbolic links are rejected at every path component',async t=>{
  const root=await fixture(t);
  await symlink(join(root,path),join(root,'agent-one/job-one/1/link.md'));
  await assert.rejects(readArtifact(root,'agent-one/job-one/1/link.md',metadata),errorCode('INVALID_ARTIFACT_PATH'));
  await symlink(join(root,'agent-one'),join(root,'linked-agent'));
  await assert.rejects(readArtifact(root,'linked-agent/job-one/1/report.md',metadata),errorCode('INVALID_ARTIFACT_PATH'));
  await symlink('/etc',join(root,'outside'));
  await assert.rejects(readArtifact(root,'outside/passwd',metadata),errorCode('INVALID_ARTIFACT_PATH'));
});

test('mutated, truncated and oversized artifacts fail integrity verification',async t=>{
  const root=await fixture(t);
  await writeFile(join(root,path),Buffer.alloc(bytes.length,120));
  await assert.rejects(readArtifact(root,path,metadata),errorCode('ARTIFACT_INTEGRITY_MISMATCH'));
  await writeFile(join(root,path),'short');
  await assert.rejects(readArtifact(root,path,metadata),errorCode('ARTIFACT_INTEGRITY_MISMATCH'));
  await assert.rejects(readArtifact(root,path,{...metadata,size:MAX_ARTIFACT_BYTES+1}),errorCode('INVALID_ARTIFACT_METADATA'));
  await assert.rejects(readArtifact(root,path,{...metadata,sha256:'invalid'}),errorCode('INVALID_ARTIFACT_METADATA'));
});

test('directories, missing content and symbolic-link roots never become artifact content',async t=>{
  const root=await fixture(t);
  await assert.rejects(readArtifact(root,'agent-one/job-one/1',metadata),errorCode('INVALID_ARTIFACT_PATH'));
  await assert.rejects(readArtifact(root,'agent-one/job-one/1/missing.md',metadata),errorCode('ARTIFACT_NOT_FOUND'));
  const rootLink=join(root,'alias');await symlink(root,rootLink);
  await assert.rejects(readArtifact(rootLink,path,metadata),errorCode('INVALID_ARTIFACT_PATH'));
});

test('zero-byte artifacts use their real SHA-256 and are distinct from missing files',async t=>{
  const root=await fixture(t);
  await writeFile(join(root,path),'');
  const empty={size:0,sha256:createHash('sha256').update('').digest('hex')};
  assert.equal((await readArtifact(root,path,empty)).length,0);
});
