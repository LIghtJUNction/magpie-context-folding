import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/store.js';

const cli = join(dirname(import.meta.dir), 'src', 'cli.ts');
async function fixture(run: (scope: string, directory: string, invoke: (args: string[], input?: string) => Promise<{ code: number; out: string; err: string }>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'folding-cli-'));
  try {
    const stateDirectory = join(directory, 'state');
    const store = new Store(stateDirectory);
    const scope = await store.scopeFor('cli-roundtrip');
    await store.transaction(scope, true, 64 * 1024 * 1024, state => {
      state.entries = [{ id: 'a', role: 'assistant', text: '原文🙂\n```ts\nexact();\n```\n',
        mark: { disposition: 'foldable', summary: 'short' }, folded: 'short', layers: [{ id: 'layer', previousId: 'original', text: 'short' }] }];
    });
    const invoke = async (args: string[], input?: string) => {
      const child = Bun.spawn([process.execPath, cli, ...args], { cwd: directory,
        env: { ...process.env, MAGPIE_CONTEXT_FOLDING_STATE_DIR: stateDirectory, XDG_CONFIG_HOME: join(directory, 'config') },
        stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input), stdout: 'pipe', stderr: 'pipe' });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, out, err };
    };
    await run(scope, directory, invoke);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('actual CLI roundtrip handles raw text, stdin marks, paste and JSON navigation', async () => {
  await fixture(async (scope, directory, invoke) => {
    const read = await invoke(['read', '--scope', scope, '--id', 'a']);
    assert.equal(read.code, 0);
    assert.equal(read.err, '');
    assert.equal(read.out, '原文🙂\n```ts\nexact();\n```\n');
    const list = await invoke(['list', '--scope', scope, '--json']);
    assert.equal(JSON.parse(list.out).entries[0].disposition, 'keep');
    const marks = JSON.stringify([{ id: 'a', disposition: 'foldable', summary: 'done again' }]);
    const mark = await invoke(['mark', '--scope', scope, '--marks', '-'], marks);
    assert.equal(mark.code, 0);
    assert.equal(JSON.parse(mark.out).pending, true);
    const output = join(directory, 'paste.txt');
    const paste = await invoke(['paste', '--scope', scope, '--id', 'a', '--path', output]);
    assert.equal(paste.code, 0);
    assert.equal(await readFile(output, 'utf8'), read.out);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(paste.out).text, undefined);
    const layer = await invoke(['read', '--scope', scope, '--id', 'a', '--layer', 'layer', '--peek', '--json']);
    assert.equal(layer.code, 0);
    assert.equal(JSON.parse(layer.out).text, 'short');
    assert.equal(JSON.parse(layer.out).kept, false);
    const status = await invoke(['status', '--scope', scope]);
    assert.equal(JSON.parse(status.out).folded, 0);
    const stats = await invoke(['stats', '--scope', scope, '--json']);
    assert.equal(stats.code, 0);
    assert.equal(JSON.parse(stats.out).metrics.originalReadCalls, 1);
    assert.equal((await invoke(['stats'])).code, 0);
  });
});

test('CLI keeps recovery available with disabled or broken config and redacts effective settings', async () => {
  await fixture(async (scope, directory, invoke) => {
    const config = join(directory, '.context-folding.toml');
    await writeFile(config, '[folding]\nenabled = false\n[magpie.accounting]\nurl = "https://user:secret@example.test/secret-token"\n');
    const effective = await invoke(['config', '--project-dir', directory, '--json']);
    assert.equal(effective.code, 0);
    assert.equal(JSON.parse(effective.out).config.folding.enabled, false);
    assert.equal(JSON.parse(effective.out).config.magpie.accounting.url, '[redacted]');
    assert.ok(!effective.out.includes('secret'));
    assert.equal((await invoke(['read', '--scope', scope, '--id', 'a'])).code, 0);
    await writeFile(config, '[folding]\nenabled = "private-secret"\n');
    const broken = await invoke(['config']);
    assert.equal(broken.code, 1);
    assert.equal(broken.out, '');
    assert.ok(!broken.err.includes('private-secret'));
    assert.equal((await invoke(['read', '--scope', scope, '--id', 'a'])).code, 0);
    assert.equal((await invoke(['mark', '--scope', scope, '--id', 'a', '--disposition', 'keep'])).code, 0);
  });
});

test('stats shows folding, detail views and compact token totals with exact JSON values', async () => {
  await fixture(async (scope, directory, invoke) => {
    await new Store(join(directory, 'state')).recordMetrics(scope, {
      foldBatchesApproved: 7, originalReadCalls: 2, layerReadCalls: 3,
      foldedTokensEstimated: '1250000000',
    });
    const result = await invoke(['stats', '--scope', scope]);
    assert.equal(result.code, 0, result.err);
    assert.ok(result.out.startsWith('净收益：未验证'));
    assert.ok(result.out.includes('费用证明：暂无（0 次已核实比较）'));
    assert.ok(!result.out.includes('USD 0.000000000'));
    assert.ok(result.out.includes('折叠次数：7'));
    assert.ok(result.out.includes('查看详情次数：5'));
    assert.ok(result.out.includes('累计折叠 token（估算）：1.25B'));
    const json = await invoke(['stats', '--scope', scope, '--json']);
    assert.equal(json.code, 0, json.err);
    assert.deepEqual(JSON.parse(json.out).summary, {
      foldCount: 7, detailViewCount: 5,
      foldedTokensEstimated: '1250000000', foldedTokensDisplay: '1.25B',
    });
    await new Store(join(directory, 'state')).recordMetrics(scope, {
      certifiedComparisons: 1, savingNanoUsdLower: '1250000000',
    });
    const conditional = await invoke(['stats', '--scope', scope]);
    assert.equal(conditional.code, 0, conditional.err);
    assert.ok(conditional.out.startsWith('净收益：未验证'));
    assert.ok(conditional.out.includes('证书假设下的节省下界累计：USD 1.250000000（1 次比较）'));
  });
});

test('CLI invalid commands and arguments use stderr, exit 1 and never leak supplied secrets', async () => {
  await fixture(async (scope, _directory, invoke) => {
    for (const args of [ ['unknown-private-secret'], ['read'], ['read', '--scope', scope, '--id', 'a', '--offset', '1.5'],
      ['read', '--scope', scope, '--id', 'a', '--offset', '-1'], ['stats', '--scope', 'private-secret'],
      ['mark', '--scope', scope, '--marks', '{private-secret'], ['mark', '--scope', scope, '--marks', '[]', '--id', 'a'],
      ['read', '--scope', scope, '--id', 'a', '--keep-folded'], ['read', '--scope', scope, '--id', 'a', '--limit', '24001'] ]) {
      const result = await invoke(args);
      assert.equal(result.code, 1, JSON.stringify(args));
      assert.equal(result.out, '');
      assert.ok(result.err.length > 0);
      assert.ok(!result.err.includes('private-secret'));
      assert.ok(!result.err.includes(scope));
    }
    assert.equal((await invoke(['--help'])).code, 0);
    assert.equal((await invoke(['read', '--help'])).code, 0);
  });
});
