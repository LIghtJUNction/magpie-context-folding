import { createHash, randomBytes } from 'node:crypto';
import { constants, closeSync, fchmodSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface ArchiveFile { path: string; text: string }
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';

function privateDirectory(path: string): void {
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Archive directory must be a real directory');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fchmodSync(fd, 0o700); fsyncSync(fd); } finally { closeSync(fd); }
}

/** Files are ordinary UTF-8, immutable, and published only after fsync. */
export function publishArchiveFiles(directory: string, scope: string, files: readonly ArchiveFile[]): void {
  if (!files.length) return;
  if (!/^[a-f0-9]{64}$/.test(scope)) throw new Error('Invalid archive scope');
  const root = join(directory, 'archives');
  privateDirectory(root);
  const folder = join(root, scope);
  privateDirectory(folder);
  for (const file of files) {
    if (dirname(file.path) !== folder || !/^[a-f0-9]{64}\.(txt|messages\.txt|jsonl)$/.test(file.path.slice(folder.length + 1))) {
      throw new Error('Invalid archive file path');
    }
    if (Buffer.from(file.text, 'utf8').toString('utf8') !== file.text) throw new Error('Archive text must be valid Unicode');
    const verify = () => {
      const info = lstatSync(file.path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Archive file must be a regular file');
      const fd = openSync(file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const actual = readFileSync(fd);
        if (!actual.equals(Buffer.from(file.text, 'utf8'))) throw new Error('Archive file content mismatch');
        fchmodSync(fd, 0o600);
        fsyncSync(fd);
      } finally { closeSync(fd); }
    };
    try { verify(); continue; } catch (error) { if (!missing(error)) throw error; }
    const temporary = join(folder, `.${randomBytes(16).toString('hex')}.tmp`);
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try { writeFileSync(fd, file.text, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
      // A hard link atomically publishes a complete file and never replaces an
      // existing target. Concurrent writers of the same snapshot must agree.
      try { linkSync(temporary, file.path); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
      verify();
    } finally { unlinkSync(temporary); }
  }
  for (const path of [folder, root, directory]) {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}

/** Called under the SQLite writer lock, including unpublished/orphaned files. */
export function archiveFileBytes(directory: string): number {
  const root = join(directory, 'archives');
  let scopes: string[];
  try {
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error('Invalid archive directory');
    scopes = readdirSync(root);
  } catch (error) { if (missing(error)) return 0; throw error; }
  let bytes = 0;
  for (const scope of scopes) {
    const folder = join(root, scope);
    const info = lstatSync(folder);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid archive directory');
    for (const name of readdirSync(folder)) {
      const item = lstatSync(join(folder, name));
      if (!item.isFile() || item.isSymbolicLink()) throw new Error('Invalid archive file');
      bytes += item.size;
    }
  }
  return bytes;
}

export function archivePaths(directory: string, scope: string, entry: { text: string; transcript?: string | undefined }): { path: string; transcriptPath?: string } {
  if (!/^[a-f0-9]{64}$/.test(scope)) throw new Error('Invalid archive scope');
  const identifier = hash(entry.transcript ?? entry.text);
  const base = join(directory, 'archives', scope, identifier);
  return { path: entry.transcript === undefined ? `${base}.txt` : `${base}.messages.txt`, ...(entry.transcript === undefined ? {} : { transcriptPath: `${base}.jsonl` }) };
}
