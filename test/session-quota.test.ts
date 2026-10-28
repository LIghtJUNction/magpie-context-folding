import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Database } from 'bun:sqlite';
import { onRequest } from '../src/context.hooks.js';
import { Store, digest } from '../src/store.js';
import { execute } from '../src/tool.js';

const text = 'Finished work. '.repeat(100);
const region = (label: string, content: string) => `@context-fold begin ${label}\n${content}\n@context-fold end ${label}`;
const body = {
  model: 'synthetic',
  tools: [{ type: 'function', function: { name: 'exec_command' } }],
  messages: [{ role: 'assistant', content: region('completed', text) }, { role: 'user', content: 'Continue.' }],
};
const id = digest(text);
const call = async (args: unknown) => JSON.parse(await execute(args));
const largerBody = (label: string, content: string) => ({ ...body,
  messages: [...body.messages, { role: 'assistant', content: region(label, content) }],
});

async function fixture(run: (f: {
  directory: string; scope: string;
  configure: (maxSessionBytes: number, input?: typeof body) => Promise<unknown>;
  stored: () => { revision: number; snapshot: string };
}) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'folding-session-quota-'));
  const previousState = process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
  const previousConfig = process.env.XDG_CONFIG_HOME;
  process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = directory;
  process.env.XDG_CONFIG_HOME = join(directory, 'config');
  await mkdir(join(directory, '.git'));
  try {
    const context = { protocol: 'chat', model: 'synthetic', session: 'quota', cwd: directory };
    const store = new Store();
    const scope = await store.scopeFor(JSON.stringify([context.session, '', '', directory]));
    await run({
      directory, scope,
      configure: (maxSessionBytes, input = body) => onRequest(input, { ...context, options: { maxSessionBytes, delayRequests: 0, minSavingsTokens: 0, recoveryCommand: 'magpie-context-folding' } }),
      stored: () => {
        const database = new Database(join(directory, 'state.sqlite'), { readonly: true });
        try {
          return database.query('SELECT revision, snapshot FROM sessions WHERE scope = ?').get(scope) as {
            revision: number; snapshot: string;
          };
        } finally { database.close(); }
      },
    });
  } finally {
    if (previousState === undefined) delete process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
    else process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = previousState;
    if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfig;
    await rm(directory, { recursive: true, force: true });
  }
}

test('annotation archival honors the configured quota and preserves the whole request on failure', async () => {
  await fixture(async f => {
    assert.notDeepEqual(await f.configure(4096), body);
    const before = f.stored();
    assert.equal(JSON.parse(before.snapshot).sessionLimitBytes, 4096);
    const large = largerBody('too-large', 'larger evidence '.repeat(1000));
    assert.deepEqual(await f.configure(4096, large), large);
    assert.deepEqual(f.stored(), before, 'an over-quota batch must not commit partial archives or references');
  });
});

test('read, paste and inspection preserve the request quota instead of raising it to their recovery ceiling', async () => {
  for (const action of ['read', 'paste', 'list', 'status', 'stats']) {
    await fixture(async f => {
      await f.configure(4096);
      const args = { action, scope: f.scope, ...(['read', 'paste'].includes(action) ? { id } : {}),
        ...(action === 'paste' ? { path: join(f.directory, 'recovered.txt') } : {}) };
      assert.equal((await call(args)).error, undefined, action);
      assert.equal(JSON.parse(f.stored().snapshot).sessionLimitBytes, 4096, action);
      const before = f.stored();
      const large = largerBody('too-large', 'larger evidence '.repeat(1000));
      assert.deepEqual(await f.configure(4096, large), large);
      assert.deepEqual(f.stored(), before);
    });
  }
});

test('request configuration can raise a quota without changing archived content', async () => {
  await fixture(async f => {
    await f.configure(4096);
    const before = JSON.parse(f.stored().snapshot);
    await f.configure(32768);
    const after = JSON.parse(f.stored().snapshot);
    assert.equal(after.sessionLimitBytes, 32768);
    // Re-running the hook refreshes its observation, not the folding cycle or archives.
    assert.notEqual(after.decision.observation.requestId, before.decision.observation.requestId);
    assert.deepEqual({ ...after, sessionLimitBytes: 4096,
      decision: { ...after.decision, observation: before.decision.observation } }, before);
    const large = largerBody('new-content', 'larger evidence '.repeat(1000));
    assert.notDeepEqual(await f.configure(32768, large), large);
    const archived = JSON.parse(f.stored().snapshot);
    assert.ok(archived.payloadBytes > 4096 && archived.payloadBytes <= 32768);
    assert.equal(archived.sessionLimitBytes, 32768);
  });
});

test('request configuration installs a missing quota on an unchanged legacy archive', async () => {
  await fixture(async f => {
    await f.configure(4096);
    const database = new Database(join(f.directory, 'state.sqlite'));
    try {
      database.query("UPDATE sessions SET snapshot = json_remove(snapshot, '$.sessionLimitBytes') WHERE scope = ?").run(f.scope);
    } finally { database.close(); }
    const legacy = JSON.parse(f.stored().snapshot);
    assert.equal(legacy.sessionLimitBytes, undefined);
    await f.configure(4096);
    const { sessionLimitBytes, ...payload } = JSON.parse(f.stored().snapshot);
    assert.equal(sessionLimitBytes, 4096);
    assert.deepEqual({ ...payload, decision: { ...payload.decision, observation: legacy.decision.observation } },
      legacy, 'installing a quota must not invent a new folding cycle or count a repeated fold');
  });
});

test('lowering the quota keeps oversized snapshots recoverable while rejecting growth', async () => {
  await fixture(async f => {
    const large = largerBody('large', 'larger evidence '.repeat(1000));
    await f.configure(32768, large);
    await f.configure(2048, large);
    const before = f.stored();
    assert.equal(JSON.parse(before.snapshot).sessionLimitBytes, 2048);
    assert.ok(JSON.parse(before.snapshot).payloadBytes > 2048);
    const growth = { ...large, messages: [...large.messages, { role: 'assistant', content: region('additional', 'more '.repeat(1000)) }] };
    assert.deepEqual(await f.configure(2048, growth), growth);
    assert.deepEqual(f.stored(), before);
    const recovered = await call({ action: 'read', scope: f.scope, id, limit: 24000 });
    assert.equal(recovered.text, text);
    assert.equal(recovered.layer, 'view');
    assert.equal(JSON.parse(f.stored().snapshot).sessionLimitBytes, 2048);
  });
});

test('legacy archives without a quota use the default rather than a recovery operation ceiling', async () => {
  await fixture(async f => {
    await f.configure(4096);
    const database = new Database(join(f.directory, 'state.sqlite'));
    try {
      database.query("UPDATE sessions SET snapshot = json_remove(snapshot, '$.sessionLimitBytes') WHERE scope = ?").run(f.scope);
    } finally { database.close(); }
    await new Store().transaction(f.scope, false, 4096, snapshot => {
      snapshot.entries[0]!.mark = { disposition: 'keep' };
    }, undefined, 'preserve');
    assert.equal(JSON.parse(f.stored().snapshot).sessionLimitBytes, 64 * 1024 * 1024);
  });
});
