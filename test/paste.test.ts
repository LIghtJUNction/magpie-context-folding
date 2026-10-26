import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Database } from 'bun:sqlite';
import { Store, digest } from '../src/store.js';
import { execute } from '../src/tool.js';

async function fixture(run: (directory: string, scope: string, text: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'folding-paste-'));
  const previous = process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
  process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = join(directory, 'archive');
  try {
    const store = new Store();
    const scope = await store.scopeFor('paste-test');
    const text = '原文🙂\n```ts\nconst result = "exact";\n```\n'.repeat(2000);
    await store.transaction(scope, true, 64 * 1024 * 1024, snapshot => {
      snapshot.entries.push({ id: 'source', role: 'assistant', text, mark: { disposition: 'unmarked' },
        layers: [{ id: 'short', text: 'Completed result.\n', previousId: 'original' }] });
    });
    await run(directory, scope, text);
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
    else process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

const call = async (args: unknown) => JSON.parse(await execute(args));

test('paste writes full original, layers and Unicode ranges without returning their text', async () => {
  await fixture(async (directory, scope, text) => {
    const path = join(directory, 'original.txt');
    const result = await call({ action: 'paste', scope, id: 'source', path });
    assert.equal(result.error, undefined);
    assert.equal(await readFile(path, 'utf8'), text);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(result.chars, text.length);
    assert.equal(result.bytes, Buffer.byteLength(text));
    assert.equal(result.sha256, digest(text));
    assert.equal(result.text, undefined);
    assert.equal(result.nextOffset, null);
    assert.ok(JSON.stringify(result).length < 600);
    const layerPath = join(directory, 'layer.txt');
    await call({ action: 'paste', scope, id: 'source', layer: 'short', path: layerPath });
    assert.equal(await readFile(layerPath, 'utf8'), 'Completed result.\n');
    const rangePath = join(directory, 'range.txt');
    const range = await call({ action: 'paste', scope, id: 'source', path: rangePath, offset: 2, limit: 2 });
    assert.equal(await readFile(rangePath, 'utf8'), '🙂');
    assert.equal(range.sha256, digest('🙂'));
    assert.equal(range.nextOffset, 4);
    const read = await call({ action: 'read', scope, id: 'source', limit: 4 });
    assert.equal(read.text, '原文🙂');
  });
});

test('paste rejects existing files, symlinks, invalid sources, relative paths and split Unicode ranges', async () => {
  await fixture(async (directory, scope) => {
    const path = join(directory, 'destination.txt');
    await writeFile(path, 'existing data');
    assert.ok((await call({ action: 'paste', scope, id: 'source', path })).error);
    assert.equal(await readFile(path, 'utf8'), 'existing data');
    const link = join(directory, 'link.txt');
    await symlink(path, link);
    assert.ok((await call({ action: 'paste', scope, id: 'source', path: link })).error);
    assert.equal(await readFile(path, 'utf8'), 'existing data');
    for (const extra of [{ id: 'missing' }, { layer: 'missing' }, { scope: '0'.repeat(64) },
      { path: 'relative.txt' }, { offset: 3 }, { limit: 3 }, { offset: 1_000_000 }]) {
      const destination = join(directory, 'must-not-exist.txt');
      assert.ok((await call({ action: 'paste', scope, id: 'source', path: destination, ...extra })).error);
      await assert.rejects(stat(destination), { code: 'ENOENT' });
    }
    assert.ok((await call({ action: 'paste', scope, id: 'source', path: join(directory, 'missing', 'file') })).error);
  });
});

test('full archive remains readable and pasteable when read statistics cannot grow', async () => {
  await fixture(async (directory, scope, text) => {
    const database = new Database(join(directory, 'archive', 'state.sqlite'));
    const row = database.query('SELECT snapshot FROM sessions WHERE scope = ?').get(scope) as { snapshot: string };
    const stored = JSON.parse(row.snapshot);
    stored.metrics.originalReadCalls = 9;
    stored.sessionLimitBytes = stored.payloadBytes;
    database.query('UPDATE sessions SET snapshot = ? WHERE scope = ?').run(JSON.stringify(stored), scope);
    database.close();
    const read = await call({ action: 'read', scope, id: 'source', limit: 4, peek: true });
    assert.equal(read.text, text.slice(0, 4));
    assert.equal((await new Store().readStats(scope)).metrics.originalReadCalls, 9, 'failed metrics write may be omitted');
    const path = join(directory, 'recovered.txt');
    const result = await call({ action: 'paste', scope, id: 'source', path });
    assert.equal(result.error, undefined);
    assert.equal(await readFile(path, 'utf8'), text);
  });
});
