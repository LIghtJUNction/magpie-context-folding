import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
    } });
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldXdg;
    await rm(root, { recursive: true, force: true });
  }
}

test('annotation-only defaults do not expose context capacity or output reserves', async () => {
  await fixture(async f => {
    const options = await loadOptions(undefined, f.project);
    assert.deepEqual(options, { enabled: true, maxSessionBytes: 67_108_864, delayRequests: 1,
      gatewayTimeoutMs: undefined, recoveryToolName: undefined });
    assert.deepEqual(parseOptions({ delayRequests: 0 }), {
      enabled: true, maxSessionBytes: 67_108_864, delayRequests: 0,
    });
    const { config, sources } = await loadConfig(f.project);
    assert.deepEqual(config.folding, { enabled: true, max_session_bytes: 67_108_864, delay_requests: 1 });
    assert.deepEqual(config.annotations, { enabled: true, default_fold: true, keep: [] });
    assert.deepEqual(config.gc, { enabled: false, strength: 'conservative', idle_seconds: 2_592_000,
      max_uses: 2, retention_seconds: 2_592_000, auto_purge: false });
    assert.deepEqual(config.magpie, {});
    assert.deepEqual(sources, { global: f.global, project: null });
  });
});

test('global/project/explicit fields merge without injecting defaults into partial layers', async () => {
  await fixture(async f => {
    await f.file(f.global, 'version=1\n[folding]\ndelay_requests=3\nmax_session_bytes=12000\n[magpie]\ngateway_timeout_ms=700\n');
    await f.file(join(f.project, '.context-folding.toml'), '[folding]\ndelay_requests=2\n[magpie]\nrecovery_tool_name="archive.recall"\n');
    const explicit = { enabled: false, delayRequests: 0 };
    const before = structuredClone(explicit);
    const options = await loadOptions(explicit, f.project);
    assert.equal(options.delayRequests, 0);
    assert.equal(options.maxSessionBytes, 12000);
    assert.equal(options.gatewayTimeoutMs, 700);
    assert.equal(options.recoveryToolName, 'archive.recall');
    assert.equal(options.enabled, false);
    assert.deepEqual(explicit, before);
    assert.equal((await loadOptions({}, f.project)).delayRequests, 2);
    assert.equal((await loadConfig(f.project, { folding: { max_session_bytes: 24000 } })).config.folding.delay_requests, 2);
    await f.file(join(f.project, '.context-folding.toml'), '[annotations]\nkeep=["active"]\n[gc]\nstrength="balanced"\nretention_seconds=9\n');
    await f.file(f.global, '[gc]\nidle_seconds=123\n');
    const shared = await loadConfig(f.project, { gc: { idle_seconds: 0.5 } });
    assert.deepEqual(shared.config.annotations.keep, ['active']);
    assert.equal(shared.config.gc.idle_seconds, 0.5);
    assert.equal(shared.config.gc.retention_seconds, 9);
    assert.equal(shared.config.gc.max_uses, 2);
  });
});

test('nearest project settings stop at git/worktree boundary and HOME is a fallback', async () => {
  await fixture(async f => {
    await f.file(join(f.root, '.context-folding.toml'), '[folding]\ndelay_requests=99\n');
    const child = join(f.project, 'nested');
    await mkdir(child);
    assert.equal(await projectConfigPath(child), null);
    await f.file(join(f.project, '.context-folding.toml'), '[folding]\ndelay_requests=2\nmax_session_bytes=32000\n');
    assert.equal((await loadOptions({}, child)).delayRequests, 2);
    const nearest = join(child, '.context-folding.toml');
    await f.file(nearest, '[folding]\ndelay_requests=3\n');
    assert.equal(await projectConfigPath(child), nearest);
    assert.equal((await loadOptions({}, child)).maxSessionBytes, 67_108_864);
    await rm(nearest);
    await rm(join(f.project, '.context-folding.toml'));
    await rm(join(f.project, '.git'), { recursive: true });
    await f.file(join(f.project, '.git'), 'gitdir: /unused\n');
    assert.equal(await projectConfigPath(child), null);
    await rm(join(f.project, '.git'));
    assert.equal((await loadOptions({}, child)).delayRequests, 99);
    delete process.env.XDG_CONFIG_HOME;
    const fallback = join(process.env.HOME!, '.config/context-folding/config.toml');
    assert.equal(globalConfigPath(), fallback);
    process.env.XDG_CONFIG_HOME = '';
    assert.equal(globalConfigPath(), fallback);
  });
});

test('removed modes, thresholds, policy and accounting explain annotation migration without values', async () => {
  await fixture(async f => {
    for (const option of ['mode', 'thresholdTokens', 'keepRecentMessages', 'headChars', 'minimumSavingUsd', 'policy', 'accounting']) {
      assert.throws(() => parseOptions({ [option]: 'private-secret' }), /agent-authored @context-fold/);
      await assert.rejects(loadOptions({ [option]: 'private-secret' }, f.project), (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.ok(error.message.includes('removed'));
        assert.ok(!error.message.includes('private-secret'));
        return true;
      });
    }
    for (const content of ['[folding]\nmode="private-secret"\n', '[folding]\nthreshold_tokens=2000\n',
      '[folding]\nkeep_recent_messages=2\n', '[folding]\nhead_chars=20\n',
      '[folding]\nminimum_saving_usd=0\n', '[policy]\nmode="private-secret"\n',
      '[magpie.accounting]\nurl="https://private-secret.test/key"\n']) {
      await f.file(f.global, content);
      await assert.rejects(loadConfig(f.project), (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.equal(error.source, f.global);
        assert.ok(error.message.includes('removed'));
        assert.ok(error.message.includes('@context-fold'));
        assert.ok(!error.message.includes('private-secret'));
        return true;
      });
    }
  });
});

test('removed context window and output reserve settings fail at every config entry point', async () => {
  await fixture(async f => {
    const removed = (source: string, field: string) => (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.source, source);
      assert.equal(error.field, field);
      assert.match(error.message, /removed/);
      assert.ok(!error.message.includes('private-secret'));
      return true;
    };
    for (const key of ['contextWindowTokens', 'reserveOutputTokens']) {
      assert.throws(() => parseOptions({ [key]: 128000 }), removed('<options>', key));
      await assert.rejects(loadOptions({ [key]: 'private-secret' }, f.project), removed('<overrides>', key));
    }
    for (const key of ['context_window_tokens', 'reserve_output_tokens']) {
      await assert.rejects(loadConfig(f.project, { folding: { [key]: 128000 } }), removed('<overrides>', `folding.${key}`));
      await f.file(f.global, `[folding]\n${key}=128000\n`);
      await assert.rejects(loadOptions({}, f.project), removed(f.global, `folding.${key}`));
      await rm(f.global);
      const project = join(f.project, '.context-folding.toml');
      await f.file(project, `[folding]\n${key}="private-secret"\n`);
      await assert.rejects(loadConfig(f.project), removed(project, `folding.${key}`));
      await rm(project);
    }
  });
});

test('strict schema and numeric limits report safe source paths', async () => {
  await fixture(async f => {
    for (const content of ['unknown=1', 'version=2', 'version=true', 'folding=false',
      '[folding]\nunknown=1', '[folding]\ndelay_requests=-1', '[folding]\ndelay_requests=0.5',
      '[folding]\nmax_session_bytes=67108865', '[folding]\nenabled=1',
      '[annotations]\nkeep=[1]', '[annotations]\nkeep=[""]', '[gc]\nstrength="invalid"',
      '[gc]\nidle_seconds=315576001', '[gc]\nmax_uses=1.5', '[gc]\nauto_purge=1',
      '[magpie]\ngateway_timeout_ms=99', '[magpie]\nrecovery_tool_name="private secret"']) {
      await f.file(f.global, content);
      await assert.rejects(loadOptions({}, f.project), (error: unknown) => {
        assert.ok(error instanceof ConfigError, content);
        assert.equal(error.source, f.global);
        assert.ok(!error.message.includes('private secret'));
        return true;
      });
    }
    await rm(f.global);
    for (const explicit of [false, [], { 'private-key': 'private-secret' }, { enabled: 1 },
      { delayRequests: Number.MAX_SAFE_INTEGER + 1 }, { maxSessionBytes: 0 }]) {
      await assert.rejects(loadOptions(explicit, f.project), (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.ok(!error.message.includes('private-key'));
        assert.ok(!error.message.includes('private-secret'));
        return true;
      });
    }
  });
});

test('TOML, UTF-8, read errors and the one MiB size boundary fail without echoing input', async () => {
  await fixture(async f => {
    await f.file(f.global, 'private-secret = [');
    await assert.rejects(loadConfig(f.project), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.source, f.global);
      assert.ok(!error.message.includes('private-secret'));
      return true;
    });
    await f.file(f.global, new Uint8Array([255]));
    await assert.rejects(loadConfig(f.project), ConfigError);
    await f.file(f.global, '#' + ' '.repeat(1024 * 1024 - 1));
    await loadConfig(f.project);
    await f.file(f.global, '#' + ' '.repeat(1024 * 1024));
    await assert.rejects(loadConfig(f.project), /exceed/);
    await rm(f.global);
    await mkdir(f.global);
    await assert.rejects(loadConfig(f.project), ConfigError);
  });
});
