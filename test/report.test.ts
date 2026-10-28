import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/store.js';
import { collectReport } from '../src/report.js';
import { escapeHtml, renderReport } from '../src/report-html.js';
import { onRequest, onResponse } from '../src/context.hooks.js';
import { execute } from '../src/tool.js';

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
    assert.deepEqual(await readdir(join(directory, 'state')), ['state.sqlite']);
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

test('report counts independent v3 occurrence trees and stays unchanged by archive queries', async () => {
  await fixture(async directory => {
    const block = (label: string, text: string) => `@context-fold begin ${label}\n${text}\n@context-fold end ${label}`;
    const parent = 'completed evidence '.repeat(400) + '\n' + block('middle', block('leaf', 'needle🙂'));
    const context = { protocol: 'chat', model: 'fixture', session: 'report-v3-tree', cwd: directory,
      options: { delayRequests: 0 }, state: {} };
    const input = { tools: [{ type: 'function', function: { name: 'exec_command' } }], messages: [
      { role: 'assistant', content: block('first', parent) + '\n' + block('second', parent) },
      { role: 'user', content: 'Continue.' },
    ] };
    const store = new Store(join(directory, 'state'));
    const scope = await store.scopeFor(JSON.stringify([context.session, '', '', directory]));
    const output = await onRequest(input, context);
    assert.equal(JSON.stringify(output).match(/\[\[cf:v3:[a-f0-9]{64}\]\]/g)?.length, 2);
    await onResponse({}, { ...context, success: true, request: output });
    const nodes = await store.inspect(scope, snapshot => structuredClone(snapshot.entries));
    assert.equal(nodes.length, 6);
    assert.equal(nodes.filter(node => node.folded !== undefined).length, 6);
    const roots = nodes.filter(node => node.annotation?.parentId === null);
    assert.equal(roots[0]!.annotation!.sha256, roots[1]!.annotation!.sha256);
    assert.notEqual(roots[0]!.id, roots[1]!.id);
    const before = await readFile(join(directory, 'state', 'state.sqlite'));
    const report = await collectReport(scope);
    assert.equal(report.sessions[0]!.entries, 6);
    assert.equal(report.sessions[0]!.foldedEntries, 2, 'count occurrences without recounting covered descendants');
    assert.equal(report.sessions[0]!.observation?.foldedRegions, 2);
    assert.match(renderReport(report), /也不代表请求节省量/);
    for (const request of [
      { action: 'read', id: roots[0]!.id }, { action: 'meta', id: roots[0]!.id },
      { action: 'list', recursive: true }, { action: 'search', query: 'needle' },
    ]) assert.equal(JSON.parse(await execute({ ...request, scope })).error, undefined);
    assert.deepEqual((await collectReport(scope)).sessions, report.sessions);
    assert.deepEqual(await readFile(join(directory, 'state', 'state.sqlite')), before);

    const leaf = nodes.find(node => node.annotation?.label === 'leaf')!;
    assert.equal(JSON.parse(await execute({ action: 'read', scope, id: leaf.id, restore: true })).error, undefined);
    const restored = await collectReport(scope);
    assert.equal(restored.sessions[0]!.foldedEntries, 1, 'restoring one leaf releases that occurrence tree only');
    assert.equal(restored.sessions[0]!.observation?.foldedRegions, 2, 'last request observation is separate from current archive state');
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

test('real annotation projection reports full request sizes, response state and no private binding', async () => {
  await fixture(async (directory) => {
    const context = { protocol: 'chat', model: 'MODEL_PRIVATE_SECRET', session: 'SESSION_PRIVATE_SECRET', cwd: directory,
      options: { delayRequests: 0 }, state: {} };
    const input = { model: context.model, tools: [{ type: 'function', function: { name: 'exec_command' } }], messages: [
      { role: 'assistant', content: '<!-- @context-fold begin completed -->\n' + '正文 PRIVATE_SECRET '.repeat(800) + '\n<!-- @context-fold end completed -->' },
      { role: 'user', content: 'Continue the task.' },
    ] };
    const store = new Store(join(directory, 'state'));
    const scope = await store.scopeFor(JSON.stringify([context.session, '', '', directory]));
    const output = await onRequest(input, context);
    assert.match(JSON.stringify(output), /\[\[cf:v3:[a-f0-9]{64}\]\]/);
    const report = await collectReport(scope);
    const session = report.sessions[0]!;
    const beforeBytes = Buffer.byteLength(JSON.stringify(input));
    const afterBytes = Buffer.byteLength(JSON.stringify(output));
    assert.deepEqual(session.comparison, { beforeBytes, afterBytes });
    assert.ok(afterBytes < beforeBytes);
    assert.equal(session.approved, null, 'a projection is not cost approval or a successful response');
    assert.equal(session.observation?.status, 'pending');
    assert.equal(session.observation?.foldedRegions, 1);
    assert.equal(session.observation?.replayedReferences, 0);
    assert.equal(session.observation?.waiting, 0);
    assert.match(session.reason, /本次请求含折叠内容/);
    const binding = await store.transaction(scope, false, 64 * 1024 * 1024, snapshot =>
      snapshot.decision.observation as { requestId: string; sessionKey: string });
    for (const secret of ['PRIVATE_SECRET', scope, binding.requestId, binding.sessionKey]) {
      assert.equal(JSON.stringify(report).includes(secret), false);
      assert.equal(renderReport(report).includes(secret), false);
    }
    const database = join(directory, 'state', 'state.sqlite');
    const before = await readFile(database);
    const beforeStat = await stat(database);
    const pendingHtml = renderReport(await collectReport(scope));
    assert.match(pendingHtml, /请求投影待确认/);
    assert.match(pendingHtml, /原始请求/);
    assert.match(pendingHtml, /最终投影/);
    assert.match(pendingHtml, /包含系统指导等开销/);
    assert.ok(pendingHtml.includes(`${Math.ceil(beforeBytes / 4).toLocaleString('en-US')} → ${Math.ceil(afterBytes / 4).toLocaleString('en-US')}`));
    assert.doesNotMatch(pendingHtml, /未识别的原因|没有记录前后字节数|批准状态未记录/);
    assert.deepEqual(await readFile(database), before);
    assert.equal((await stat(database)).mtimeMs, beforeStat.mtimeMs);

    const completingAt = Date.now();
    await onResponse({}, { ...context, success: true, request: output });
    const confirmed = await collectReport(scope);
    assert.equal(confirmed.sessions[0]!.observation?.status, 'confirmed');
    const completedAt = confirmed.sessions[0]!.observation?.completedAt;
    assert.equal(typeof completedAt, 'number');
    assert.ok(completedAt! >= completingAt && completedAt! <= Date.now());
    const confirmedHtml = renderReport(confirmed);
    assert.match(confirmedHtml, /已匹配成功响应/);
    assert.ok(confirmedHtml.includes(`回调记录时间：${new Date(completedAt!).toISOString()}`));
    for (const secret of ['PRIVATE_SECRET', scope, binding.requestId, binding.sessionKey]) {
      assert.equal(JSON.stringify(confirmed).includes(secret), false);
      assert.equal(confirmedHtml.includes(secret), false);
    }
    assert.equal(confirmed.statistics.money.actualBillSavingUsd, null);
  });
});

test('request reports distinguish grace periods, absent current folds and unsuccessful responses', async () => {
  await fixture(async directory => {
    const context = { protocol: 'chat', model: 'fixture', session: 'report-lifecycle', cwd: directory,
      options: { delayRequests: 1 }, state: {} };
    const input = { tools: [{ type: 'function', function: { name: 'exec_command' } }], messages: [
      { role: 'assistant', content: '<!-- @context-fold begin done -->\n' + 'completed work '.repeat(1000) + '\n<!-- @context-fold end done -->' },
      { role: 'user', content: 'Continue.' },
    ] };
    const scope = await new Store(join(directory, 'state')).scopeFor(JSON.stringify([context.session, '', '', directory]));
    const waiting = await onRequest(input, context);
    const waitingReport = await collectReport(scope);
    assert.equal(waitingReport.sessions[0]!.observation?.foldedRegions, 0);
    assert.equal(waitingReport.sessions[0]!.observation?.waiting, 1);
    assert.match(waitingReport.sessions[0]!.reason, /等待周期/);
    await onResponse({}, { ...context, success: true, request: waiting });

    const nextInput = { ...input, messages: [...input.messages, { role: 'user', content: 'A different next request.' }] };
    const folded = await onRequest(nextInput, context);
    assert.match(JSON.stringify(folded), /\[\[cf:v3:[a-f0-9]{64}\]\]/);
    await onResponse({}, { ...context, success: false, request: folded });
    const failed = await collectReport(scope);
    assert.equal(failed.sessions[0]!.observation?.status, 'failed');
    assert.match(renderReport(failed), /请求失败/);
    assert.equal(failed.statistics.metrics.successfulFoldedRequests, 0);

    const retry = await onRequest(nextInput, context);
    await onResponse({}, { ...context, request: retry });
    const unverified = await collectReport(scope);
    assert.equal(unverified.sessions[0]!.observation?.status, 'unverified');
    assert.match(renderReport(unverified), /响应未核实/);

    await onRequest({ ...input, messages: [{ role: 'user', content: 'A new history with no old annotation.' }] }, context);
    const absent = await collectReport(scope);
    assert.equal(absent.sessions[0]!.foldedEntries, 1, 'the recoverable archive remains');
    assert.equal(absent.sessions[0]!.observation?.foldedRegions, 0, 'archive count is not current-request count');
    assert.equal(absent.sessions[0]!.observation?.replayedReferences, 0);
    assert.match(absent.sessions[0]!.reason, /本次没有可折叠区域/);
    assert.match(renderReport(absent), /归档数量不代表最近记录的请求实际包含的折叠数量/);
  });
});

test('current reasons in older records are recognized without inventing missing measurements', async () => {
  await fixture(async (directory, scope) => {
    await new Store(join(directory, 'state')).transaction(scope, false, 64 * 1024 * 1024, snapshot => {
      snapshot.decision = { reason: 'annotated-regions-folded', foldedRegions: 2, waiting: 0, replayedReferences: 0 };
    });
    const report = await collectReport(scope);
    assert.equal(report.sessions[0]!.comparison, null);
    assert.equal(report.sessions[0]!.observation, undefined);
    const html = renderReport(report);
    assert.doesNotMatch(html, /未识别的原因/);
    assert.match(html, /没有记录前后字节数/);
    assert.doesNotMatch(html, /已匹配成功响应/);
  });
});
