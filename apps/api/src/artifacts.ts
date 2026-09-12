import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { DomainError } from './domain.js';

export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
export interface ArtifactIntegrity { size: number; sha256: string }

function segments(path: string): string[] {
  if (typeof path !== 'string' || path.length === 0 || path.length > 1000 ||
      isAbsolute(path) || !/^[A-Za-z0-9_./-]+$/.test(path)) {
    throw new DomainError('INVALID_ARTIFACT_PATH', 'Artifact path must be storage-relative.', 400);
  }
  const parts = path.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new DomainError('INVALID_ARTIFACT_PATH', 'Artifact path cannot contain empty or traversal segments.', 400);
  }
  return parts;
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function verifyPath(root: string, parts: string[]): Promise<string> {
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = resolve(current, parts[index]!);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) {
      throw new DomainError('INVALID_ARTIFACT_PATH', 'Symbolic links are not allowed in artifact paths.', 400);
    }
    if (index < parts.length - 1 && !stat.isDirectory()) {
      throw new DomainError('INVALID_ARTIFACT_PATH', 'Artifact parent must be a directory.', 400);
    }
  }
  const canonical = await realpath(current);
  if (!contained(root, canonical)) {
    throw new DomainError('INVALID_ARTIFACT_PATH', 'Artifact path escapes its storage root.', 400);
  }
  return canonical;
}

/**
 * Read only the immutable bytes described by accepted metadata. The caller verifies
 * organization/scope and (for publication) the current worker lease before calling.
 * Both publication and download must use this helper so later tampering is detected.
 */
export async function readArtifact(
  root: string,
  path: string,
  expected: ArtifactIntegrity,
  expectedPrefix?: string,
): Promise<Buffer> {
  const parts = segments(path);
  if (expectedPrefix !== undefined) {
    const prefix = segments(expectedPrefix.replace(/\/$/, '')).join('/');
    if (!path.startsWith(`${prefix}/`)) {
      throw new DomainError('ARTIFACT_SCOPE_DENIED', 'Artifact path is outside the authorized agent, job and attempt.', 403);
    }
  }
  if (!Number.isSafeInteger(expected.size) || expected.size < 0 || expected.size > MAX_ARTIFACT_BYTES ||
      !/^[a-f0-9]{64}$/.test(expected.sha256)) {
    throw new DomainError('INVALID_ARTIFACT_METADATA', 'Artifact metadata requires a valid SHA-256 and size at most 10 MiB.', 400);
  }

  let handle: FileHandle | undefined;
  try {
    const rootStat = await lstat(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new DomainError('INVALID_ARTIFACT_PATH', 'Artifact storage root must be a directory, not a symbolic link.', 400);
    }
    const canonicalRoot = await realpath(root);
    const canonicalPath = await verifyPath(canonicalRoot, parts);
    handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new DomainError('INVALID_ARTIFACT_PATH', 'Artifacts must be regular files.', 400);
    }
    if (before.size !== expected.size || before.size > MAX_ARTIFACT_BYTES) {
      throw new DomainError('ARTIFACT_INTEGRITY_MISMATCH', 'Artifact size differs from accepted metadata.', 422);
    }
    // Recheck path and inode after opening so a replaced file cannot be accepted.
    const checkedPath = await verifyPath(canonicalRoot, parts);
    const pathStat = await lstat(checkedPath);
    if (checkedPath !== canonicalPath || pathStat.dev !== before.dev || pathStat.ino !== before.ino) {
      throw new DomainError('ARTIFACT_INTEGRITY_MISMATCH', 'Artifact changed while opening.', 422);
    }
    // A bounded descriptor read avoids allocating from a file that grows after stat.
    const bytes = Buffer.alloc(expected.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    const after = await handle.stat();
    const content = bytes.subarray(0, length);
    if (length !== expected.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
        createHash('sha256').update(content).digest('hex') !== expected.sha256) {
      throw new DomainError('ARTIFACT_INTEGRITY_MISMATCH', 'Artifact bytes differ from accepted metadata.', 422);
    }
    await verifyPath(canonicalRoot, parts);
    return content;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new DomainError('ARTIFACT_NOT_FOUND', 'Artifact content is unavailable.', 404);
    }
    if (code === 'ELOOP') {
      throw new DomainError('INVALID_ARTIFACT_PATH', 'Symbolic links are not allowed in artifact paths.', 400);
    }
    throw new DomainError('ARTIFACT_READ_FAILED', 'Artifact content could not be read safely.', 500);
  } finally {
    await handle?.close();
  }
}
