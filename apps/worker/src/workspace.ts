import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { WorkerError } from './errors.js';

export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;

/** Logical read roots exposed to the model's workspace-files tool. */
export type FileRoot = 'briefs' | 'workspace' | 'output';

export interface StoredFile {
  /** Storage-relative path, safe to publish as an artifact. */
  path: string;
  sha256: string;
  size: number;
  content: Buffer;
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Reject empty, absolute, traversal or otherwise unsafe relative paths. The
 * control plane independently re-validates every published path, so this guard
 * only prevents the worker from writing outside its configured roots.
 */
export function safeRelativePath(path: string): string {
  if (typeof path !== 'string' || path.length === 0 || path.length > 900 || isAbsolute(path)) {
    throw new WorkerError('INVALID_PATH', 'File paths must be short, relative and non-empty');
  }
  if (!/^[A-Za-z0-9_./ -]+$/.test(path)) throw new WorkerError('INVALID_PATH', `Unsupported characters in path: ${path}`);
  const parts = path.split('/');
  const cleaned: string[] = [];
  for (const part of parts) {
    const segment = part.trim();
    if (segment === '' || segment === '.' || segment === '..') throw new WorkerError('INVALID_PATH', `Unsafe path segment in ${path}`);
    const safe = segment.replace(/[^A-Za-z0-9_.-]/g, '-').replace(/\.+$/, '') || 'file';
    cleaned.push(safe);
  }
  return cleaned.join('/');
}

export class Workspace {
  constructor(
    private readonly artifactRoot: string,
    private readonly sourceRoot: string,
  ) {}

  jobPrefix(agentId: string, jobId: string, attempt: number): string {
    return `${agentId}/${jobId}/${attempt}`;
  }

  private resolveWithin(root: string, relativePath: string): string {
    const candidate = resolve(root, safeRelativePath(relativePath));
    if (!contained(resolve(root), candidate) && candidate !== resolve(root)) {
      throw new WorkerError('INVALID_PATH', 'Resolved path escapes its configured root');
    }
    return candidate;
  }

  private rootFor(root: FileRoot, agentId: string): string {
    if (root === 'briefs') return this.sourceRoot;
    if (root === 'workspace') return join(this.artifactRoot, agentId, 'workspace');
    return join(this.artifactRoot, agentId, 'output');
  }

  /** Persist immutable bytes for one attempt and return their publication metadata. */
  async writeArtifact(agentId: string, jobId: string, attempt: number, name: string, content: string | Buffer): Promise<StoredFile> {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
      throw new WorkerError('ARTIFACT_TOO_LARGE', `Artifacts may not exceed ${MAX_ARTIFACT_BYTES} bytes`);
    }
    const relativePath = `${this.jobPrefix(agentId, jobId, attempt)}/${safeRelativePath(name)}`;
    const absolute = this.resolveWithin(this.artifactRoot, relativePath);
    await mkdir(dirname(absolute), { recursive: true });
    // Immutable publication: refuse to overwrite bytes already written for this attempt.
    if (await this.existsAbsolute(absolute)) {
      const existing = await readFile(absolute);
      if (!existing.equals(bytes)) throw new WorkerError('ARTIFACT_IMMUTABLE', `Attempt already published different bytes at ${relativePath}`);
    } else {
      await writeFile(absolute, bytes);
    }
    return { path: relativePath, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.byteLength, content: bytes };
  }

  /** Write agent-scoped working knowledge that is not tied to a single attempt. */
  async writeWorkspaceFile(agentId: string, name: string, content: string): Promise<string> {
    const relativePath = safeRelativePath(name);
    const absolute = this.resolveWithin(this.rootFor('workspace', agentId), relativePath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, 'utf8');
    return relativePath;
  }

  async read(root: FileRoot, agentId: string, relativePath: string): Promise<string> {
    const absolute = this.resolveWithin(this.rootFor(root, agentId), relativePath);
    try {
      const info = await stat(absolute);
      if (!info.isFile()) throw new WorkerError('NOT_A_FILE', `${relativePath} is not a regular file`);
      if (info.size > MAX_ARTIFACT_BYTES) throw new WorkerError('FILE_TOO_LARGE', `${relativePath} exceeds the readable size limit`);
      return await readFile(absolute, 'utf8');
    } catch (error) {
      if (error instanceof WorkerError) throw error;
      throw new WorkerError('FILE_UNAVAILABLE', `Cannot read ${root}:${relativePath}: ${(error as Error).message}`);
    }
  }

  async list(root: FileRoot, agentId: string, directory = '.'): Promise<{ path: string; size: number }[]> {
    const base = this.rootFor(root, agentId);
    const start = directory === '.' ? base : this.resolveWithin(base, directory);
    const results: { path: string; size: number }[] = [];
    const walk = async (current: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const absolute = join(current, entry.name);
        if (entry.isDirectory()) {
          await walk(absolute);
        } else if (entry.isFile()) {
          const info = await stat(absolute);
          results.push({ path: relative(base, absolute).split(sep).join('/'), size: info.size });
          if (results.length >= 200) return;
        }
      }
    };
    await walk(start);
    return results.sort((a, b) => a.path.localeCompare(b.path));
  }

  private async existsAbsolute(absolute: string): Promise<boolean> {
    try {
      return (await stat(absolute)).isFile();
    } catch {
      return false;
    }
  }

  /** Durable write/read/hash probe used by runtime and restart verification. */
  async probe(agentId: string, jobId: string, attempt: number, name: string, content: string): Promise<StoredFile> {
    const stored = await this.writeArtifact(agentId, jobId, attempt, name, content);
    const roundTrip = await readFile(this.resolveWithin(this.artifactRoot, stored.path));
    if (roundTrip.byteLength !== stored.size || createHash('sha256').update(roundTrip).digest('hex') !== stored.sha256) {
      throw new WorkerError('WORKSPACE_INTEGRITY', `Workspace probe ${stored.path} did not round-trip`);
    }
    return stored;
  }
}
