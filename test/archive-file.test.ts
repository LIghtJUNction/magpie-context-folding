import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { archivePath, saveArchiveFile } from '../src/archive-file.js';
import { digest } from '../src/store.js';

test('reused archives synchronize file and directory and propagate synchronization failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cf archive sync '));
  try {
    const text = 'externally restored original';
    const hash = digest(text);
    const path = archivePath(directory, hash);
    await writeFile(path, text);
    // Keep the filesystem mock in a child process so other tests use real fs.
    for (const failure of ['none', 'file', 'directory']) {
      const script = `
        import { mock } from 'bun:test';
        import * as fs from 'node:fs';
        const real = { ...fs };
        const calls = [];
        mock.module('node:fs', () => ({ ...real, fsyncSync(fd) {
          const kind = real.fstatSync(fd).isDirectory() ? 'directory' : 'file';
          calls.push(kind);
          if (kind === ${JSON.stringify(failure)}) throw new Error('simulated sync failure');
          real.fsyncSync(fd);
        }}));
        const { saveArchiveFile } = await import(${JSON.stringify(new URL('../src/archive-file.ts', import.meta.url).href)});
        let error = null;
        try { saveArchiveFile(${JSON.stringify(directory)}, ${JSON.stringify(hash)}, ${JSON.stringify(text)}); }
        catch (caught) { error = caught.message; }
        console.log(JSON.stringify({ calls, error }));
      `;
      const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
      assert.equal(child.status, 0, child.stderr);
      const result = JSON.parse(child.stdout);
      assert.deepEqual(result.calls, failure === 'file' ? ['file'] : ['file', 'directory']);
      assert.equal(result.error, failure === 'none' ? null : 'simulated sync failure');
      assert.equal(await readFile(path, 'utf8'), text);
      assert.deepEqual(await readdir(join(directory, 'archive')), [hash + '.txt']);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('portable archive files preserve exact bytes and reject corrupted or symbolic targets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cf archive '));
  try {
    const text = '原文🙂\r\n\n exact ';
    const hash = digest(text);
    const path = saveArchiveFile(directory, hash, text);
    assert.equal(await readFile(path, 'utf8'), text);
    const before = await stat(join(directory, 'archive'), { bigint: true });
    assert.equal(saveArchiveFile(directory, hash, text), path);
    const after = await stat(join(directory, 'archive'), { bigint: true });
    assert.equal(after.mtimeNs, before.mtimeNs, 'reuse must not create and remove temporary archive files');
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
