import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/store.js';
import { collectReport } from '../src/report.js';
import { escapeHtml, renderReport } from '../src/report-html.js';

const cli = join(import.meta.dir, '..', 'src', 'cli.ts');
async function fixture(run: (directory: string, scope: string, invoke: (args: string[]) => Promise<{ code: number; out: string; err: string }>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'folding-report-'));
  const previous = process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
  const stateDirectory = join(directory, 'state');
  process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = stateDirectory;
  try {
    const store = new Store(stateDirectory);
    const scope = await store.scopeFor('report-private-secret');
    await store.transaction(scope, true, 64 * 1024 * 1024, state => {
      state.entries = [
        { id: '/secret/entry', role: 'assistant', text: 'RAW_PRIVATE_SECRET',
          mark: { disposition: 'foldable', summary: 'SUMMARY_PRIVATE_SECRET' }, folded: 'FOLDED_PRIVATE_SECRET',
          layers: [{ id: 'private-layer', previousId: 'original', text: 'LAYER_PRIVATE_SECRET' }] },
        { id: 'kept-private', role: 'user', text: 'USER_PRIVATE_SECRET', mark: { disposition: 'keep' }, layers: [] },
        { id: 'other-private', role: 'assistant', text: 'OTHER_PRIVATE_SECRET', mark: { disposition: 'unmarked' }, layers: [] },
      ];
      state.groups = [{ id: 'private-group', children: ['/secret/entry', 'other-private'], summary: 'GROUP_PRIVATE_SECRET', enabled: true, folded: 'GROUP_FOLD_PRIVATE_SECRET' }];
      state.decision = { reason: 'bytes-smaller-no-cost-proof', approved: true, beforeBytes: 10000, afterBytes: 4000,
        model: 'MODEL_PRIVATE_SECRET', path: '/secret/path', assumptions: ['ASSUMPTION_PRIVATE_SECRET'] };
      state.metrics.foldBatchesApproved = 2;
      state.metrics.itemsFolded = 3;
      state.metrics.estimatedTokenDelta = '-12345678901234567890';
    });
    const invoke = async (args: string[]) => {
      const child = Bun.spawn([process.execPath, cli, ...args], {
        cwd: directory, env: { ...process.env, MAGPIE_CONTEXT_FOLDING_STATE_DIR: stateDirectory },
        stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, out, err };
    };
    await run(directory, scope, invoke);
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
    else process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test('report CLI is private, offline and read-only with faithful counts and candidate evidence', async () => {
  await fixture(async (directory, scope, invoke) => {
    const database = join(directory, 'state', 'state.sqlite');
    const before = await readFile(database);
    const beforeStat = await stat(database);
    const output = join(directory, 'report.html');
    const result = await invoke(['report', '--output', output]);
    assert.equal(result.code, 0, result.err);
    const html = await readFile(output, 'utf8');
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.deepEqual(await readFile(database), before);
    assert.equal((await stat(database)).mtimeMs, beforeStat.mtimeMs);
    assert.deepEqual((await readdir(join(directory, 'state'))).sort(), ['archives', 'state.sqlite']);
    for (const secret of ['PRIVATE_SECRET', '/secret/', 'private-layer', scope, 'private-group']) {
      assert.ok(!html.includes(secret), secret);
      assert.ok(!result.out.includes(secret));
    }
    assert.ok(html.includes('actualBillSavingUsd = null'));
    assert.ok(html.includes('10,000 B'));
    assert.ok(html.includes('4,000 B'));
    assert.ok(html.includes('6,000 B'));
    assert.ok(html.includes('-12,345,678,901,234,567,890'));
    assert.ok(html.includes('bytes-smaller-no-cost-proof'));
    assert.ok(html.includes('已批准'));
    assert.ok(html.includes("connect-src 'none'"));
    assert.ok(!/<script[^>]+src=|<link|https?:\/\//i.test(html));
    const report = await collectReport(scope);
    assert.equal(report.statistics.scope, 'session');
    assert.deepEqual(report.sessions[0], {
      label: '会话 1', entries: 3, foldedEntries: 0, keptEntries: 1, layers: 1, groups: 1, foldedGroups: 1,
      reason: '字节更少；没有费用证明 (bytes-smaller-no-cost-proof)',
      nextCheck: '当前只证明候选字节更少。需要费用判断时，补齐相同任务全部新增成本边界并使用 cost 模式。', approved: true,
      comparison: { beforeBytes: 10000, afterBytes: 4000 },
    });
    await new Store(join(directory, 'state')).transaction(scope, false, 64 * 1024 * 1024, snapshot => {
      snapshot.decision = { reason: '</script><script>PRIVATE_SECRET</script>', approved: false };
    });
    const redacted = renderReport(await collectReport(scope));
    assert.ok(redacted.includes('未识别的原因'));
    assert.ok(redacted.includes('没有记录前后字节数'));
    assert.ok(redacted.includes('证据不足，无法定位原因'));
    assert.ok(redacted.includes('不是已确认的根因'));
    await new Store(join(directory, 'state')).transaction(scope, false, 64 * 1024 * 1024, snapshot => {
      snapshot.decision = { reason: 'policy-incremental-cost-bounds-missing', approved: false };
    });
    const missingCosts = renderReport(await collectReport(scope));
    assert.ok(missingCosts.includes('合计费用不再乘次数'));
    assert.ok(missingCosts.includes('未知值不能填零'));
    await new Store(join(directory, 'state')).transaction(scope, false, 64 * 1024 * 1024, snapshot => {
      snapshot.decision = {};
    });
    assert.ok(renderReport(await collectReport(scope)).includes('证据不足，无法定位原因'));
    assert.ok(!redacted.includes('PRIVATE_SECRET'));
    const rejected = report.sessions[0]!;
    rejected.approved = false;
    assert.ok(renderReport(report).includes('候选未获批准；候选条形不代表实际发送'));
    rejected.comparison = { beforeBytes: 0, afterBytes: 0 };
    assert.ok(!renderReport(report).includes('NaN'));
  });
});

test('report excludes folded entries covered by nested groups and retains independent folds', async () => {
  await fixture(async (directory, scope) => {
    const store = new Store(join(directory, 'state'));
    await store.transaction(scope, false, 64 * 1024 * 1024, snapshot => {
      snapshot.entries.push({ id: 'independent-private', role: 'tool', text: 'INDEPENDENT_PRIVATE_SECRET',
        mark: { disposition: 'unmarked' }, folded: 'short', layers: [] });
      delete snapshot.groups![0]!.folded;
      snapshot.groups!.push({ id: 'outer-private', children: ['private-group', 'kept-private'],
        summary: 'OUTER_PRIVATE_SECRET', enabled: true, folded: 'outer fold' });
    });
    const nested = await collectReport(scope);
    assert.equal(nested.sessions[0]!.foldedEntries, 1);
    assert.equal(nested.sessions[0]!.foldedGroups, 1);
    assert.ok(!JSON.stringify(nested).includes('outer-private'));
    await store.transaction(scope, false, 64 * 1024 * 1024, snapshot => {
      delete snapshot.groups![1]!.folded;
    });
    assert.equal((await collectReport(scope)).sessions[0]!.foldedEntries, 2);
  });
});

test('report leads with unverified benefit for estimates and conditional cost bounds', async () => {
  await fixture(async (directory, scope) => {
    const unverified = renderReport(await collectReport(scope));
    assert.ok(unverified.includes('<h1>净收益未验证</h1>'));
    assert.ok(unverified.includes('<p class="money">无费用证明</p>'));
    assert.ok(unverified.includes('请求体积估算不能证明省钱或提速'));
    assert.ok(unverified.includes('未知，不按零计算'));

    await new Store(join(directory, 'state')).transaction(scope, false, 64 * 1024 * 1024, snapshot => {
      snapshot.metrics.certifiedComparisons = 1;
      snapshot.metrics.savingNanoUsdLower = '1250000000';
    });
    const conditional = renderReport(await collectReport(scope));
    assert.ok(conditional.includes('<h1>净收益未验证</h1>'));
    assert.ok(conditional.includes('已有条件下界；实际账单节省与耗时改善仍未测得'));
    assert.ok(conditional.includes('<p class="money">1.250000000</p>'));
    assert.ok(conditional.includes('actualBillSavingUsd = null'));
    assert.ok(!conditional.includes('<p class="money">无费用证明</p>'));
  });
});

test('report refuses overwrite, symlink, relative path and secret-bearing invalid options', async () => {
  await fixture(async (directory, scope, invoke) => {
    const output = join(directory, 'existing.html');
    await writeFile(output, 'preserve');
    const link = join(directory, 'symlink.html');
    await symlink(output, link);
    const dangling = join(directory, 'dangling.html');
    const absent = join(directory, 'absent.html');
    await symlink(absent, dangling);
    for (const args of [
      ['report', '--output', output], ['report', '--output', link], ['report', '--output', dangling],
      ['report', '--output', 'PRIVATE_SECRET.html'], ['report'],
      ['report', '--scope', 'PRIVATE_SECRET', '--output', join(directory, 'invalid.html')],
      ['report', '--scope', 'f'.repeat(64), '--output', join(directory, 'unknown.html')],
      ['report', '--output', '/missing-PRIVATE_SECRET/report.html'],
    ]) {
      const result = await invoke(args);
      assert.equal(result.code, 1, JSON.stringify(args));
      assert.equal(result.out, '');
      assert.ok(!result.err.includes('PRIVATE_SECRET'));
      assert.ok(!result.err.includes(scope));
    }
    assert.equal(await readFile(output, 'utf8'), 'preserve');
    await assert.rejects(stat(absent), { code: 'ENOENT' });
    assert.equal((await invoke(['report', '--help'])).code, 0);
    assert.equal(escapeHtml('<script a="\'">&'), '&lt;script a=&quot;&#39;&quot;&gt;&amp;');
    const report = await collectReport();
    report.sessions[0]!.label = '<img src=x onerror="evil()">';
    report.sessions[0]!.reason = '<script>evil()</script>';
    report.sessions[0]!.nextCheck = '<img src=x onerror="evil()">';
    report.generatedAt = '<script>evil()</script>';
    const escaped = renderReport(report);
    assert.ok(!escaped.includes('<img'));
    assert.ok(!escaped.includes('<script>evil()'));
    assert.ok(escaped.includes('&lt;script&gt;evil()&lt;/script&gt;'));
  });
});

test('report on unused installation stays empty and creates no state directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'folding-report-empty-'));
  try {
    const state = join(directory, 'absent-state');
    const output = join(directory, 'empty.html');
    const child = Bun.spawn([process.execPath, cli, 'report', '--output', output], {
      env: { ...process.env, MAGPIE_CONTEXT_FOLDING_STATE_DIR: state }, stdout: 'pipe', stderr: 'pipe',
    });
    const [code, , err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    assert.equal(code, 0, err);
    assert.ok((await readFile(output, 'utf8')).includes('还没有归档会话'));
    await assert.rejects(stat(state), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
