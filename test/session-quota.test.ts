import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Database } from 'bun:sqlite';
import { onRequest } from '../src/context.hooks.js';
import { extractSpans } from '../src/protocol.js';
import { Store } from '../src/store.js';
import { execute } from '../src/tool.js';

const body = {
  model: 'synthetic',
  tools: [{ type: 'function', function: { name: 'context_folding' } }],
  messages: [{ role: 'assistant', content: 'Finished work.' }, { role: 'user', content: 'Continue.' }],
};
const id = extractSpans(body, 'chat')[0]!.id;
const call = async (args: unknown) => JSON.parse(await execute(args));

async function fixture(run: (f: {
  directory: string;
  scope: string;
  configure: (maxSessionBytes: number) => Promise<void>;
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
      configure: async maxSessionBytes => {
        const result = await onRequest(body, { ...context,
          options: { maxSessionBytes, keepRecentMessages: 1, policy: { mode: 'bytes', autoRoles: [] } },
        });
        assert.ok(JSON.stringify(result).includes('<context-folding scope='));
      },
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

test('foldable marks honor the request session quota and reject atomically', async () => {
  await fixture(async f => {
    await f.configure(2048);
    const before = f.stored();
    assert.equal(JSON.parse(before.snapshot).sessionLimitBytes, 2048);
    const result = await call({ action: 'mark', scope: f.scope,
      marks: [{ id, disposition: 'foldable', summary: 's'.repeat(1900) }],
    });
    assert.match(result.error ?? '', /Session archive full/);
    assert.deepEqual(f.stored(), before);
  });
});

test('recovery and inspection tools retain the configured session quota', async () => {
  for (const action of ['read', 'paste', 'keep', 'unmarked', 'list', 'status']) {
    await fixture(async f => {
      await f.configure(2048);
      const args = action === 'keep' || action === 'unmarked'
        ? { action: 'mark', scope: f.scope, marks: [{ id, disposition: action }] }
        : { action, scope: f.scope, ...(['read', 'paste'].includes(action) ? { id } : {}),
          ...(action === 'paste' ? { path: join(f.directory, 'recovered.txt') } : {}) };
      assert.equal((await call(args)).error, undefined, action);
      assert.equal(JSON.parse(f.stored().snapshot).sessionLimitBytes, 2048, action);
      const result = await call({ action: 'mark', scope: f.scope,
        marks: [{ id, disposition: 'foldable', summary: 's'.repeat(1900) }],
      });
      assert.match(result.error ?? '', /Session archive full/, action);
    });
  }
});

test('the request configuration can raise a quota even when the snapshot is unchanged', async () => {
  await fixture(async f => {
    await f.configure(2048);
    const before = JSON.parse(f.stored().snapshot);
    await f.configure(4096);
    const after = JSON.parse(f.stored().snapshot);
    assert.equal(after.sessionLimitBytes, 4096);
    assert.deepEqual({ ...after, sessionLimitBytes: 2048 }, before);
    const result = await call({ action: 'mark', scope: f.scope,
      marks: [{ id, disposition: 'foldable', summary: 's'.repeat(1900) }],
    });
    assert.equal(result.error, undefined);
    const marked = JSON.parse(f.stored().snapshot);
    assert.ok(marked.payloadBytes > 2048 && marked.payloadBytes <= 4096);
    assert.equal(marked.sessionLimitBytes, 4096);
  });
});

test('request configuration installs the quota on an unchanged legacy archive', async () => {
  await fixture(async f => {
    await f.configure(2048);
    const database = new Database(join(f.directory, 'state.sqlite'));
    try {
      database.query("UPDATE sessions SET snapshot = json_remove(snapshot, '$.sessionLimitBytes') WHERE scope = ?")
        .run(f.scope);
    } finally { database.close(); }
    const legacy = JSON.parse(f.stored().snapshot);
    assert.equal(legacy.sessionLimitBytes, undefined);
    await f.configure(2048);
    const configured = f.stored();
    const { sessionLimitBytes, ...payload } = JSON.parse(configured.snapshot);
    assert.equal(sessionLimitBytes, 2048);
    assert.deepEqual(payload, legacy, 'the configured quota must persist without payload changes');
    const result = await call({ action: 'mark', scope: f.scope,
      marks: [{ id, disposition: 'foldable', summary: 's'.repeat(1900) }],
    });
    assert.match(result.error ?? '', /Session archive full/);
    assert.deepEqual(f.stored(), configured);
  });
});

test('lowering a quota preserves oversized archives and still permits recovery', async () => {
  await fixture(async f => {
    await f.configure(4096);
    assert.equal((await call({ action: 'mark', scope: f.scope,
      marks: [{ id, disposition: 'foldable', summary: 's'.repeat(1900) }],
    })).error, undefined);
    await f.configure(2048);
    const before = f.stored();
    assert.equal(JSON.parse(before.snapshot).sessionLimitBytes, 2048);
    assert.ok(JSON.parse(before.snapshot).payloadBytes > 2048);
    assert.match((await call({ action: 'mark', scope: f.scope,
      marks: [{ id, disposition: 'foldable', summary: 's'.repeat(2000) }],
    })).error ?? '', /Session archive full/);
    assert.deepEqual(f.stored(), before);
    const recovered = await call({ action: 'read', scope: f.scope, id });
    assert.equal(recovered.text, body.messages[0]!.content);
    assert.equal(recovered.kept, true);
    assert.equal(JSON.parse(f.stored().snapshot).sessionLimitBytes, 2048);
  });
});

test('legacy archives use the default quota instead of an operation ceiling', async () => {
  await fixture(async f => {
    await f.configure(2048);
    const database = new Database(join(f.directory, 'state.sqlite'));
    try {
      database.query("UPDATE sessions SET snapshot = json_remove(snapshot, '$.sessionLimitBytes') WHERE scope = ?")
        .run(f.scope);
    } finally { database.close(); }
    await new Store().transaction(f.scope, false, 2048, snapshot => {
      snapshot.entries[0]!.mark = { disposition: 'keep' };
    }, undefined, 'preserve');
    assert.equal(JSON.parse(f.stored().snapshot).sessionLimitBytes, 64 * 1024 * 1024);
  });
});
