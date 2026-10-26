import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/store.js';
import { execute } from '../src/tool.js';
import { ContextFoldingPlugin } from '../src/index.js';

const cli = new URL('../src/cli.ts', import.meta.url).pathname;
const call = async (args: unknown) => JSON.parse(await execute(args));
async function fixture(run: (store: Store, scope: string, directory: string, text: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'folding-cli-'));
  const previous = process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
  process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = join(directory, 'state');
  try {
    const store = new Store();
    const scope = await store.scopeFor('cli-tool');
    const text = 'exact 中文🙂\n'.repeat(6000);
    await store.transaction(scope, true, 64 * 1024 * 1024, state => {
      state.entries = ['a', 'b', 'c'].map(id => ({ id, text, role: 'tool', mark: { disposition: 'foldable', summary: 'completed' },
        folded: 'summary', layers: [{ id: 'layer', text: 'summary', previousId: 'original' }] }));
      state.entries[0]!.version = { kind: 'file', series: 'file', number: 1, automatic: true };
      state.groups = [
        { id: 'inner', children: ['a', 'b'], summary: 'inner', enabled: true, folded: 'inner summary' },
        { id: 'outer', children: ['inner', 'c'], summary: 'outer', enabled: true, folded: 'outer summary' },
      ];
    });
    await run(store, scope, directory, text);
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
    else process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}
const load = (store: Store, scope: string) => store.transaction(scope, false, 64 * 1024 * 1024, state => structuredClone(state));
async function command(directory: string, args: string[], input?: string) {
  const process = Bun.spawn([Bun.which('bun')!, cli, ...args], {
    cwd: directory, env: { ...globalThis.process.env, XDG_CONFIG_HOME: join(directory, 'config') },
    stdin: input === undefined ? 'ignore' : new Blob([input]), stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  return { stdout, stderr, code };
}

test('default original/layer read and paste keep the source and release all ancestors', async () => {
  for (const action of ['read', 'paste']) for (const layer of ['original', 'layer']) {
    await fixture(async (store, scope, directory) => {
      const result = await call({ action, scope, id: 'a', layer, ...(action === 'paste' ? { path: join(directory, 'result') } : {}) });
      assert.equal(result.error, undefined);
      assert.equal(result.kept, true);
      const state = await load(store, scope);
      assert.equal(state.entries[0]?.mark.disposition, 'keep');
      assert.equal(state.entries[0]?.manual, true);
      assert.equal(state.entries[0]?.version?.automatic, false);
      assert.equal(state.entries[0]?.folded, undefined);
      assert.ok(state.groups?.every(group => !group.enabled && group.folded === undefined));
      assert.equal(state.metrics.itemsRestored, 3);
      assert.equal(state.entries[0]?.layers[0]?.text, 'summary');
      await call({ action: 'read', scope, id: 'a', peek: true });
      assert.equal((await load(store, scope)).entries[0]?.mark.disposition, 'keep');
      await call({ action: 'mark', scope, marks: [{ id: 'a', disposition: 'foldable', summary: 'explicit again' }] });
      assert.equal((await load(store, scope)).entries[0]?.mark.disposition, 'foldable');
      assert.ok((await load(store, scope)).groups?.every(group => !group.enabled));
    });
  }
});

test('peek preserves existing marks, versions, layers and every ancestor fold', async () => {
  await fixture(async (store, scope, directory) => {
    const before = await load(store, scope);
    for (const action of ['read', 'paste']) {
      assert.equal((await call({ action, scope, id: 'a', peek: true, ...(action === 'paste' ? { path: join(directory, 'peek') } : {}) })).kept, false);
    }
    const after = await load(store, scope);
    assert.deepEqual(after.entries, before.entries);
    assert.deepEqual(after.groups, before.groups);
    assert.equal(after.metrics.itemsRestored, 0);
    const plugin = await ContextFoldingPlugin();
    const actions = plugin.tool.context_folding.args.oneOf as any[];
    for (const name of ['read', 'paste']) assert.equal(actions.find(action => action.properties.action.const === name).properties.peek.default, false);
  });
});

test('CLI restores full exact text with no added newline and supports JSON/pipe marks/config', async () => {
  await fixture(async (store, scope, directory, text) => {
    await writeFile(join(directory, '.context-folding.toml'), '[folding]\nenabled = false\n[magpie.accounting]\nurl = "https://example.com/secret?key=hidden"\n');
    const config = await command(directory, ['config']);
    assert.equal(config.code, 0);
    assert.equal(JSON.parse(config.stdout).config.folding.enabled, false);
    assert.ok(!config.stdout.includes('hidden'));
    const read = await command(directory, ['read', '--scope', scope, '--id', 'a']);
    assert.deepEqual(read, { code: 0, stdout: text, stderr: '' });
    assert.equal((await load(store, scope)).entries[0]?.mark.disposition, 'keep');
    const json = await command(directory, ['read', '--scope', scope, '--id', 'a', '--json']);
    assert.equal(JSON.parse(json.stdout).text, text);
    const range = await command(directory, ['read', '--scope', scope, '--id', 'a', '--offset', '11', '--limit', '11', '--json']);
    assert.equal(range.code, 0);
    assert.equal(JSON.parse(range.stdout).text, text.slice(11, 22));
    assert.equal(JSON.parse(range.stdout).nextOffset, 22);
    const tail = await command(directory, ['read', '--scope', scope, '--id', 'a', '--offset', String(text.length - 11)]);
    assert.equal(tail.stdout, text.slice(-11));
    const stdinMarks = await command(directory, ['mark', '--scope', scope], JSON.stringify([{ id: 'b', disposition: 'keep' }]));
    assert.equal(stdinMarks.code, 0);
    assert.equal((await load(store, scope)).entries[1]?.mark.disposition, 'keep');
    const marks = await command(directory, ['mark', '--scope', scope, '--marks', '-'], JSON.stringify([{ id: 'a', disposition: 'foldable', summary: 'again' }]));
    assert.equal(marks.code, 0);
    const peek = await command(directory, ['paste', '--scope', scope, '--id', 'a', '--path', '-', '--peek']);
    assert.equal(peek.stdout, text);
    assert.equal((await load(store, scope)).entries[0]?.mark.disposition, 'foldable');
    const destination = join(directory, 'destination');
    assert.equal((await command(directory, ['paste', '--scope', scope, '--id', 'a', '--path', destination])).code, 0);
    assert.equal(await readFile(destination, 'utf8'), text);
    for (const action of ['status', 'list', 'stats']) {
      const result = await command(directory, [action, '--scope', scope, '--json']);
      assert.equal(result.code, 0);
      assert.doesNotThrow(() => JSON.parse(result.stdout));
    }
    const invalid = await command(directory, ['read', '--scope', scope, '--id', 'a', '--offset', '1e2']);
    assert.equal(invalid.code, 1);
    assert.equal(invalid.stdout, '');
    assert.ok(!invalid.stderr.includes(scope));
  });
});

test('malformed input and filesystem errors never echo supplied secrets', async () => {
  await fixture(async (_store, scope, directory) => {
    const secret = 'SECRET-CAPABILITY-CONTENT';
    const invalid = await call({ action: 'read', scope, id: 'a', [secret]: secret });
    assert.ok(!JSON.stringify(invalid).includes(secret));
    const failure = await call({ action: 'paste', scope, id: 'a', path: join(directory, secret, 'file') });
    assert.ok(failure.error);
    assert.ok(!JSON.stringify(failure).includes(secret));
  });
});
