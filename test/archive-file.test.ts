import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archivePath, saveArchiveFile } from '../src/archive-file.js';
import { digest } from '../src/store.js';

test('portable archive files preserve exact bytes and reject corrupted or symbolic targets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cf archive '));
  try {
    const text = '原文🙂\r\n\n exact ';
    const hash = digest(text);
    const path = saveArchiveFile(directory, hash, text);
    assert.equal(await readFile(path, 'utf8'), text);
    assert.equal(saveArchiveFile(directory, hash, text), path);
    await writeFile(path, 'corrupt');
    assert.throws(() => saveArchiveFile(directory, hash, text), /content mismatch/);
    assert.equal(await readFile(path, 'utf8'), 'corrupt');
    await rm(path);
    const other = join(directory, 'other.txt');
    await writeFile(other, text);
    await symlink(other, path);
    assert.throws(() => saveArchiveFile(directory, hash, text));
    assert.deepEqual((await readdir(join(directory, 'archive'))).filter(name => name.endsWith('.tmp')), []);
    assert.throws(() => archivePath(directory, '../invalid'), /Invalid archive hash/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
