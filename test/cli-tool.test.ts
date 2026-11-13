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
