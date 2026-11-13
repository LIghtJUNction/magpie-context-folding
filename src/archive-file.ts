import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Plain UTF-8 content-addressed files, independent of any Agent protocol. */
export function archivePath(directory: string, hash: string): string {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid archive hash');
  const root = resolve(directory, 'archive');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(realpathSync(root), `${hash}.txt`);
  if (/[\r\n\0]/.test(path)) throw new Error('Invalid archive path');
  return path;
}

export function saveArchiveFile(directory: string, hash: string, text: string): string {
  if (createHash('sha256').update(text, 'utf8').digest('hex') !== hash) throw new Error('Archive hash mismatch');
  const path = archivePath(directory, hash);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, text, 'utf8');
      fsyncSync(fd);
    } finally { closeSync(fd); }
    try { linkSync(temporary, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const existing = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!readFileSync(existing).equals(Buffer.from(text, 'utf8'))) throw new Error('Archive file content mismatch');
      fsyncSync(existing);
    } finally { closeSync(existing); }
    const parent = openSync(resolve(path, '..'), 'r');
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } finally { unlinkSync(temporary); }
  return path;
}
