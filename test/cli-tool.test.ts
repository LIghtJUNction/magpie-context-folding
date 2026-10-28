import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/store.js';
import { execute } from '../src/tool.js';

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
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd: directory, env: { ...globalThis.process.env, XDG_CONFIG_HOME: join(directory, 'config') },
    stdin: input === undefined ? 'ignore' : new Blob([input]), stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}

test('CLI restores paginated exact text with no added newline and supports JSON/range/pipe export/config', async () => {
  await fixture(async (store, scope, directory, text) => {
    await writeFile(join(directory, '.context-folding.toml'), '[folding]\nenabled = false\n');
    const config = await command(directory, ['config']);
    assert.equal(config.code, 0);
    assert.equal(JSON.parse(config.stdout).config.folding.enabled, false);
    assert.ok(!config.stdout.includes('hidden'));
    const read = await command(directory, ['read', '--scope', scope, '--id', 'a']);
    assert.equal(read.code, 0, read.stderr);
    assert.equal(read.stderr, '');
    assert.equal(read.stdout, text);
    assert.equal((await load(store, scope)).entries[0]?.mark.disposition, 'keep');
    const json = await command(directory, ['read', '--scope', scope, '--id', 'a', '--json']);
    assert.equal(JSON.parse(json.stdout).text, text);
    const range = await command(directory, ['read', '--scope', scope, '--id', 'a', '--offset', '11', '--limit', '11', '--json']);
    assert.equal(range.code, 0);
    assert.equal(JSON.parse(range.stdout).text, text.slice(11, 22));
    assert.equal(JSON.parse(range.stdout).nextOffset, 22);
    const tail = await command(directory, ['read', '--scope', scope, '--id', 'a', '--offset', String(text.length - 11)]);
    assert.equal(tail.stdout, text.slice(-11));
    const peek = await command(directory, ['paste', '--scope', scope, '--id', 'a', '--path', '-', '--peek']);
    assert.equal(peek.stdout, text);
    assert.equal((await load(store, scope)).entries[0]?.mark.disposition, 'keep');
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
