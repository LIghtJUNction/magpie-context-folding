import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { saveArchiveFile } from '../src/archive-file.js';

const cli = new URL('../src/cli.ts', import.meta.url).pathname;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
async function fixture(run: (root: string, directory: string, invoke: (args: string[]) => Promise<{ code: number; out: string; err: string }>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'archive-cli-'));
  const directory = join(root, 'archive');
  await mkdir(directory);
  const invoke = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, cli, ...args], { env: { ...process.env, MAGPIE_CONTEXT_FOLDING_STATE_DIR: root }, stdout: 'pipe', stderr: 'pipe' });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, out, err };
  };
  try { await run(root, directory, invoke); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('directory CLI reads exact Unicode originals without a database and searches literal lines', async () => {
  await fixture(async (root, directory, invoke) => {
    const text = '原文🙂\r\nfunction exact() {}\n'.repeat(2000);
    const id = hash(text);
    const path = saveArchiveFile(root, id, text);
    const result = await invoke(['read', id.slice(0, 12)]);
    assert.equal(result.code, 0, result.err);
    assert.equal(result.out, text);
    const found = await invoke(['search', '--dir', directory, 'function exact()']);
    assert.equal(found.code, 0, found.err);
    assert.ok(found.out.startsWith(`${path}:2:function exact() {}`));
    assert.equal((await invoke(['search', 'absent'])).out, '');
    const stats = JSON.parse((await invoke(['stats'])).out);
    assert.equal(stats.files, 1);
    assert.equal(stats.bytes, Buffer.byteLength(text));
    assert.deepEqual(await readdir(root), ['archive']);
  });
});

test('listing sorts by size/time/name; cleanup previews then deletes only selected hash files', async () => {
  await fixture(async (root, directory, invoke) => {
    const old = hash('old'); const recent = hash('new and longer');
    const oldPath = saveArchiveFile(root, old, 'old');
    const recentPath = saveArchiveFile(root, recent, 'new and longer');
    await utimes(oldPath, new Date(0), new Date(0));
    await writeFile(join(directory, 'notes.txt'), 'preserve');
    await mkdir(join(directory, `${'f'.repeat(64)}.txt`));
    const link = join(directory, `${'e'.repeat(64)}.txt`);
    await symlink(recentPath, link);
    assert.deepEqual(JSON.parse((await invoke(['list', '--sort', 'size', '--order', 'asc'])).out).map((f: { hash: string }) => f.hash), [old, recent]);
    assert.equal(JSON.parse((await invoke(['list', '--sort', 'time'])).out)[0].hash, recent);
    const preview = JSON.parse((await invoke(['clean', '--older-than', '1'])).out);
    assert.equal(preview.applied, false);
    assert.deepEqual(preview.files.map((f: { hash: string }) => f.hash), [old]);
    assert.equal(await readFile(oldPath, 'utf8'), 'old');
    const cleaned = await invoke(['clean', '--older-than', '1', '--apply']);
    assert.equal(cleaned.code, 0, cleaned.err);
    await assert.rejects(readFile(oldPath), { code: 'ENOENT' });
    assert.equal(await readFile(recentPath, 'utf8'), 'new and longer');
    assert.equal(await readFile(join(directory, 'notes.txt'), 'utf8'), 'preserve');
    assert.equal((await invoke(['read', 'e'.repeat(12)])).code, 1);
    assert.equal((await invoke(['clean', recent.slice(0, 12), '--apply'])).code, 0);
    assert.equal(JSON.parse((await invoke(['stats'])).out).files, 0);
  });
});

test('invalid selectors and ambiguous prefixes fail without touching files', async () => {
  await fixture(async (_root, directory, invoke) => {
    for (const id of ['a'.repeat(64), 'a'.repeat(63) + 'b']) await writeFile(join(directory, `${id}.txt`), 'keep');
    for (const args of [['read', 'a'.repeat(12)], ['read', '../notes'], ['clean', '--apply'], ['clean', '--older-than', '-1', '--apply'],
      ['clean', 'a'.repeat(64), '--older-than', '2', '--apply'], ['list', '--sort', 'invalid'], ['search'], ['read', '--scope', 'old']]) {
      const result = await invoke(args);
      assert.equal(result.code, 1, JSON.stringify(args));
      assert.equal(result.out, '');
    }
    assert.equal((await readdir(directory)).length, 2);
    const missing = join(directory, 'absent');
    assert.equal(JSON.parse((await invoke(['stats', '--dir', missing])).out).files, 0);
    await assert.rejects(readdir(missing), { code: 'ENOENT' });
  });
});
