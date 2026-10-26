import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadOptions, parseOptions } from '../src/config.js';
import { onRequest } from '../src/context.hooks.js';
import { Store } from '../src/store.js';
import { execute } from '../src/tool.js';
import { extractSpans } from '../src/protocol.js';
import { modeOptions } from '../src/modes.js';

async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'folding-modes-'));
  const saved = { state: process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR, config: process.env.XDG_CONFIG_HOME };
  process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = directory;
  process.env.XDG_CONFIG_HOME = join(directory, 'config');
  try { await run(directory); } finally {
    if (saved.state === undefined) delete process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
    else process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = saved.state;
    if (saved.config === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved.config;
    await rm(directory, { recursive: true, force: true });
  }
}

const oldTool = 'build result: PASS; source file src/main.ts\n'.repeat(8000);
const oldAssistant = 'Earlier completed exploration. '.repeat(200);
const body = {
  model: 'synthetic', tools: [{ type: 'function', function: { name: 'context_folding' } }],
  messages: [
    { role: 'user', content: 'Preserve my requirements.' },
    { role: 'assistant', content: oldAssistant },
    { role: 'assistant', tool_calls: [{ id: 'build', type: 'function', function: { name: 'build', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'build', content: oldTool },
    ...Array.from({ length: 16 }, (_, index) => ({ role: 'assistant', content: 'Recent active step ' + index })),
    { role: 'user', content: 'Continue reasoning carefully.' },
  ],
};
const context = { protocol: 'chat', model: 'synthetic', session: 'modes' };
const text = (value: unknown) => JSON.stringify(value);

test('all presets work without accounting and progressively preserve more context', async () => {
  await fixture(async directory => {
    const lengths: number[] = [];
    for (const mode of ['economy', 'balanced', 'intelligence'] as const) {
      const options = await loadOptions({ mode });
      assert.equal(options.policy.mode, 'bytes');
      assert.equal(options.mode, mode);
      assert.deepEqual(options.policy.autoRoles, modeOptions(mode).policy.autoRoles);
      const output = await onRequest(body, { ...context, session: mode, options: { mode } });
      assert.ok(text(output).includes('[context-folding id='));
      assert.ok(!text(output).includes(oldTool));
      assert.ok(text(output).includes('Preserve my requirements.'));
      assert.ok(text(output).includes('Recent active step 15'));
      lengths.push(text(output).length);
      const scope = await new Store(directory).scopeFor(JSON.stringify([mode, '', '', '']));
      const stats = JSON.parse(await execute({ action: 'stats', scope }));
      assert.equal(stats.summary.foldCount, 1);
      assert.ok(BigInt(stats.summary.foldedTokensEstimated) > 0n);
    }
    assert.ok(lengths[0]! < lengths[1]! && lengths[1]! < lengths[2]!);
  });
});

test('agentic tool switches only its session and intelligence restores automatically folded reasoning', async () => {
  await fixture(async directory => {
    const ctx = { ...context, options: { mode: 'agentic' } };
    const first = await onRequest(body, ctx);
    assert.ok(text(first).includes(oldAssistant));
    const store = new Store(directory);
    const scope = await store.scopeFor(JSON.stringify([context.session, '', '', '']));
    const select = async (mode?: string) => JSON.parse(await execute({ action: 'mode', scope, ...(mode ? { mode } : {}) }));
    assert.equal((await select()).activeMode, 'intelligence');
    assert.equal((await select('economy')).effectiveOnNextRequest, true);
    const economy = await onRequest(body, ctx);
    assert.ok(!text(economy).includes(oldAssistant));
    assert.equal(JSON.parse(await execute({ action: 'status', scope })).decision.activeMode, 'economy');
    await select('intelligence');
    const intelligent = await onRequest(body, ctx);
    assert.ok(text(intelligent).includes(oldAssistant));
    const id = extractSpans(body, 'chat').find(span => span.text === oldTool)!.id;
    const original = JSON.parse(await execute({ action: 'read', scope, id, limit: 100, peek: true }));
    assert.equal(original.text, oldTool.slice(0, 100));
    await onRequest(body, { ...context, session: 'fixed', options: { mode: 'balanced' } });
    const fixed = await store.scopeFor(JSON.stringify(['fixed', '', '', '']));
    assert.ok(JSON.parse(await execute({ action: 'mode', scope: fixed, mode: 'economy' })).error);
    assert.equal((await select()).activeMode, 'intelligence');
    assert.ok(JSON.parse(await execute({ action: 'mode', scope, mode: 'agentic' })).error);
  });
});

test('wrapped recovery is explicit and caller overrides beat preset defaults', async () => {
  await fixture(async directory => {
    const wrapped = { ...body, tools: [{ type: 'function', function: { name: 'exec' } }] };
    assert.ok(!text(await onRequest(wrapped, context)).includes('[context-folding id='));
    const result = await onRequest(wrapped, { ...context, options: {
      recoveryToolName: 'mcp__magpie__magpie_context_folding_context_folding',
    } });
    assert.ok(text(result).includes('[context-folding id='));
    assert.ok(text(result).includes('mcp__magpie__magpie_context_folding_context_folding'));
    const config = join(directory, 'config', 'context-folding');
    await mkdir(config, { recursive: true });
    await writeFile(join(config, 'config.toml'), '[folding]\nmode="economy"\nhead_chars=77\n');
    const options = await loadOptions({ mode: 'balanced', keepRecentMessages: 9 });
    assert.equal(options.thresholdTokens, 32_000);
    assert.equal(options.headChars, 77);
    assert.equal(options.keepRecentMessages, 9);
    assert.equal(parseOptions({ mode: 'economy' }).thresholdTokens, 8192);
    assert.equal(parseOptions({ mode: 'agentic' }).keepRecentMessages, 12);
    assert.equal(parseOptions({ accounting: { url: 'http://localhost/accounting' } }).policy.mode, 'cost');
    assert.equal(parseOptions({ policy: { mode: 'cost' } }).policy.mode, 'cost');
    assert.throws(() => parseOptions({ mode: 'unknown' }));
  });
});
