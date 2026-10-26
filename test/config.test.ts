import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, globalConfigPath, loadConfig, loadOptions, parseOptions, projectConfigPath } from '../src/config.js';

async function fixture(run: (f: { root: string; project: string; global: string; file: (path: string, text: string | Uint8Array) => Promise<void> }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'folding-config-'));
  const oldHome = process.env.HOME;
  const oldXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = join(root, 'home');
  process.env.XDG_CONFIG_HOME = join(root, 'xdg');
  const project = join(root, 'project');
  await mkdir(join(project, '.git'), { recursive: true });
  try {
    await run({ root, project, global: globalConfigPath(), file: async (path, text) => {
      const { dirname } = await import('node:path');
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
    } });
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldXdg;
    await rm(root, { recursive: true, force: true });
  }
}

// All environment-dependent cases share one sequential test to isolate HOME/XDG.
const sequential = async (_name: string, run: () => Promise<void>) => run();
test('global and project TOML settings', async () => {
  await sequential('defaults and backwards compatible parseOptions', () => fixture(async f => {
    const options = await loadOptions(undefined, f.project);
    assert.equal(options.enabled, true);
    assert.equal(options.thresholdTokens, 64_000);
    assert.equal(options.keepRecentMessages, 12);
    assert.equal(options.headChars, 400);
    assert.equal(options.maxSessionBytes, 67_108_864);
    assert.equal(options.minimumSavingUsd, 0.000001);
    assert.equal(options.accounting, undefined);
    assert.equal(parseOptions({ keepRecentMessages: 0 }).keepRecentMessages, 0);
    assert.throws(() => parseOptions({ unknown: 1 }));
    const { config, sources } = await loadConfig(f.project);
    assert.deepEqual(config.annotations, { enabled: true, default_fold: true, keep: [] });
    assert.deepEqual(config.gc, { enabled: false, strength: 'conservative', idle_seconds: 2_592_000,
      max_uses: 2, retention_seconds: 2_592_000, auto_purge: false });
    assert.deepEqual(config.magpie, {});
    assert.deepEqual(sources, { global: f.global, project: null });
  }));

  await sequential('model capacity cannot be set by plugin options or shared TOML', () => fixture(async f => {
    assert.ok(!Object.hasOwn(await loadOptions({}, f.project), 'contextWindowTokens'));
    assert.throws(() => parseOptions({ contextWindowTokens: 128000 }));
    await assert.rejects(loadOptions({ contextWindowTokens: 128000 }, f.project), ConfigError);
    await assert.rejects(loadOptions({ context_window_tokens: 128000 }, f.project), ConfigError);
    await f.file(f.global, '[folding]\ncontext_window_tokens=128000\n');
    await assert.rejects(loadOptions({}, f.project), ConfigError);
    await rm(f.global);
    await f.file(join(f.project, '.context-folding.toml'), '[folding]\ncontext_window_tokens=1\n');
    await assert.rejects(loadOptions({}, f.project), ConfigError);
    await f.file(join(f.project, '.context-folding.toml'), '[folding]\ncontextWindowTokens=128000\n');
    await assert.rejects(loadOptions({}, f.project), ConfigError);
    await rm(join(f.project, '.context-folding.toml'));
    await assert.rejects(loadOptions({ 'secret-key-token': 'secret-value' }, f.project), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.ok(!error.message.includes('secret-key-token'));
      assert.ok(!error.message.includes('secret-value'));
      return true;
    });
  }));

  await sequential('layers merge fields and nested accounting without resetting absent defaults', () => fixture(async f => {
    await f.file(f.global, 'version=1\n[folding]\nthreshold_tokens=123\nhead_chars=10\n[magpie.accounting]\nurl="https://private.test/secret?token=hidden"\ntimeout_ms=700\n');
    await f.file(join(f.project, '.context-folding.toml'), '[folding]\nhead_chars=20\n[magpie.accounting]\ntimeout_ms=800\n');
    const explicit = { headChars: 30, accounting: { timeoutMs: 900 } };
    const before = structuredClone(explicit);
    const options = await loadOptions(explicit, f.project);
    assert.equal(options.thresholdTokens, 123);
    assert.equal(options.headChars, 30);
    assert.deepEqual(options.accounting, { url: 'https://private.test/secret?token=hidden', timeoutMs: 900 });
    assert.deepEqual(explicit, before);
    const diagnostic = await loadConfig(f.project, { folding: { head_chars: 40 } });
    assert.equal(diagnostic.config.folding.head_chars, 40);
    assert.equal(diagnostic.config.magpie.accounting?.url, '[redacted]');
    assert.ok(!JSON.stringify(diagnostic).includes('hidden'));
    assert.ok(!JSON.stringify(diagnostic).includes('private.test'));
    assert.equal((await loadOptions({}, f.project)).accounting?.timeoutMs, 800);
  }));

  await sequential('nearest file only and stop after checking git directory or worktree marker', () => fixture(async f => {
    await f.file(join(f.root, '.context-folding.toml'), '[folding]\nhead_chars=999\n');
    const child = join(f.project, 'nested');
    await mkdir(child);
    assert.equal(await projectConfigPath(child), null);
    assert.equal((await loadOptions({}, child)).headChars, 400);
    await f.file(join(f.project, '.context-folding.toml'), '[folding]\nhead_chars=20\nthreshold_tokens=999\n');
    assert.equal((await loadOptions({}, child)).headChars, 20);
    const nearest = join(child, '.context-folding.toml');
    await f.file(nearest, '[folding]\nhead_chars=30\n');
    assert.equal(await projectConfigPath(child), nearest);
    assert.equal((await loadOptions({}, child)).thresholdTokens, 64_000);
    await rm(nearest);
    await rm(join(f.project, '.context-folding.toml'));
    await rm(join(f.project, '.git'), { recursive: true });
    await f.file(join(f.project, '.git'), 'gitdir: /unused\n');
    assert.equal(await projectConfigPath(child), null);
    await rm(join(f.project, '.git'));
    assert.equal((await loadOptions({}, child)).headChars, 999);
  }));

  await sequential('home fallback and optional accounting defaults', () => fixture(async f => {
    delete process.env.XDG_CONFIG_HOME;
    const fallback = join(process.env.HOME!, '.config/context-folding/config.toml');
    assert.equal(globalConfigPath(), fallback);
    await f.file(fallback, '[magpie.accounting]\nurl="http://localhost:8080/cost"\n');
    assert.deepEqual((await loadOptions({}, f.project)).accounting, { url: 'http://localhost:8080/cost', timeoutMs: 500 });
    process.env.XDG_CONFIG_HOME = '';
    assert.equal(globalConfigPath(), fallback);
  }));

  await sequential('strict unknown sections, keys, wrong types and bounds with source paths', () => fixture(async f => {
    const cases = [
      'unknown=1', 'version=2', 'version=true', 'folding=false', '[folding]\nunknown=1',
      '[folding]\nthreshold_tokens=0', '[folding]\nkeep_recent_messages=-1',
      '[folding]\nhead_chars=1001', '[folding]\nmax_session_bytes=67108865',
      '[folding]\nminimum_saving_usd=nan', '[folding]\nenabled=1',
      '[annotations]\nkeep=[1]', '[annotations]\nkeep=[""]',
      '[gc]\nstrength="invalid"', '[gc]\nidle_seconds=315576001', '[gc]\nmax_uses=1.5',
      '[gc]\nauto_purge=1', '[magpie]\ngateway_timeout_ms=99',
      '[magpie.accounting]\nurl="ftp://private.test/secret"',
      '[magpie.accounting]\nurl="https:///"', '[magpie.accounting]\nurl="https://exa mple.test"',
      '[magpie.accounting]\nurl="http://example.test"\ntimeout_ms=49',
      '[magpie.accounting]\nprivate_key="hidden-secret"', '[magpie.accounting]\ntimeout_ms=500',
    ];
    for (const text of cases) {
      await f.file(f.global, text);
      await assert.rejects(loadOptions({}, f.project), (error: unknown) => {
        assert.ok(error instanceof ConfigError, text);
        assert.ok(error.message.includes(f.global), text);
        assert.ok(!error.message.includes('hidden-secret'));
        assert.ok(!error.message.includes('private.test'));
        return true;
      });
    }
    await rm(f.global);
    for (const explicit of [false, [], { unknown: 'secret' }, { enabled: 1 }, { accounting: { url: 'file:///secret' } }]) {
      await assert.rejects(loadOptions(explicit, f.project), ConfigError);
    }
  }));

  await sequential('TOML parse errors never echo input and UTF8/read failures are fatal', () => fixture(async f => {
    await f.file(f.global, 'private-secret = [');
    await assert.rejects(loadConfig(f.project), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.ok(error.message.includes(f.global));
      assert.ok(!error.message.includes('private-secret'));
      return true;
    });
    await f.file(f.global, new Uint8Array([255]));
    await assert.rejects(loadConfig(f.project), ConfigError);
    await rm(f.global);
    await mkdir(f.global);
    await assert.rejects(loadConfig(f.project), ConfigError);
  }));

  await sequential('policy snake_case maps to runtime policy and inherits nested tables', () => fixture(async f => {
    await f.file(f.global, '[policy]\nmode="cost"\nauto_roles=["assistant","tool"]\nmin_chars=20\n'
      + '[policy.cost]\nbytes_per_token_lower=1\nbytes_per_token_upper=8\n'
      + '[policy.cost.input]\nlower=2\nupper=4\n[policy.cost.cache_read]\nlower=0.1\nupper=0.2\n'
      + '[policy.cost.cache_write]\nlower=2\nupper=4\n'
      + '[policy.cost.incremental]\ntool_calls=1\nmodel_round_trips=1\ninput_tokens=10\noutput_tokens=20\n'
      + 'input_price_per_million=2\noutput_price_per_million=8\ntool_fees_usd=0\n'
      + '[policy.script]\ncommand=["/usr/bin/node","--secret=hidden-token"]\n');
    await f.file(join(f.project, '.context-folding.toml'), '[policy.cost.input]\nupper=5\n[policy.cost.incremental]\ninput_tokens=100\n');
    const options = await loadOptions({ policy: { minChars: 30, cost: { overheadUsd: 0.01,
      incremental: { toolFeesUsd: 0.002 } } } }, f.project);
    assert.deepEqual(options.policy.cost?.incremental, { toolCalls: 1, modelRoundTrips: 1,
      inputTokens: 100, outputTokens: 20, inputPricePerMillion: 2, outputPricePerMillion: 8,
      toolFeesUsd: 0.002 });
    for (const incremental of [{ toolCalls: -1 }, { unknown: 0 }]) {
      await assert.rejects(loadOptions({ policy: { cost: { incremental } } }, f.project), ConfigError);
    }
    assert.equal(options.policy.minChars, 30);
    assert.deepEqual(options.policy.autoRoles, ['assistant', 'tool']);
    assert.deepEqual(options.policy.cost?.input, { lower: 2, upper: 5 });
    assert.equal(options.policy.cost?.overheadUsd, 0.01);
    assert.equal(options.policy.script?.timeoutMs, 1000);
    const diagnostic = await loadConfig(f.project);
    assert.deepEqual(diagnostic.config.policy.script?.command, ['/redacted']);
    assert.ok(!JSON.stringify(diagnostic).includes('hidden-token'));
    assert.deepEqual(diagnostic.config.policy.cost?.input, { lower: 2, upper: 5 });
    await f.file(join(f.project, '.context-folding.toml'), '[policy.cost.input]\nupper=0\n');
    await assert.rejects(loadConfig(f.project), ConfigError);
  }));

  await sequential('partial incremental bounds must be complete after merging', () => fixture(async f => {
    await f.file(f.global, '[policy.cost.incremental]\ntool_calls=1\n');
    await assert.rejects(loadOptions({}, f.project), ConfigError);
    await assert.rejects(loadOptions({ policy: { cost: { incremental: { modelRoundTrips: 1 } } } }, f.project), ConfigError);
  }));

  await sequential('policy minimum follows folding unless policy explicitly overrides it', () => fixture(async f => {
    assert.equal((await loadOptions({}, f.project)).policy.minimumSavingUsd, 0.000001);
    await f.file(f.global, '[folding]\nminimum_saving_usd=0.2\n');
    assert.equal((await loadOptions({}, f.project)).policy.minimumSavingUsd, 0.2);
    assert.equal((await loadOptions({ minimumSavingUsd: 0.4 }, f.project)).policy.minimumSavingUsd, 0.4);
    assert.equal((await loadOptions({ policy: { minimumSavingUsd: 0 } }, f.project)).policy.minimumSavingUsd, 0);
    await f.file(join(f.project, '.context-folding.toml'), '[policy]\nminimum_saving_usd=0.3\n');
    assert.equal((await loadOptions({ minimumSavingUsd: 0.9 }, f.project)).policy.minimumSavingUsd, 0.3);
    await f.file(join(f.project, '.context-folding.toml'), '[policy.script]\ntimeout_ms=100\n');
    await assert.rejects(loadOptions({}, f.project), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.source, join(f.project, '.context-folding.toml'));
      return true;
    });
  }));

  await sequential('one MiB allowed, larger sources rejected', () => fixture(async f => {
    await f.file(f.global, '#' + ' '.repeat(1024 * 1024 - 1));
    await loadConfig(f.project);
    await f.file(f.global, '#' + ' '.repeat(1024 * 1024));
    await assert.rejects(loadConfig(f.project), /exceed/);
  }));

  await sequential('zero recent messages, finite fractional GC times, and independent strength fields', () => fixture(async f => {
    await f.file(f.global, '[gc]\nidle_seconds=123\n');
    await f.file(join(f.project, '.context-folding.toml'), '[gc]\nstrength="balanced"\nretention_seconds=9\n[folding]\nkeep_recent_messages=0\n');
    const { config } = await loadConfig(f.project);
    assert.equal(config.gc.idle_seconds, 123);
    assert.equal(config.gc.max_uses, 2);
    assert.equal(config.gc.retention_seconds, 9);
    assert.equal((await loadOptions({}, f.project)).keepRecentMessages, 0);
    const result = await loadConfig(f.project, { gc: { idle_seconds: 0.5 } });
    assert.equal(result.config.gc.idle_seconds, 0.5);
  }));
});
