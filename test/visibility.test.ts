import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Database } from 'bun:sqlite';
import { onRequest, onResponse } from '../src/context.hooks.js';
import { Store, digest } from '../src/store.js';
import { bodyFor, fixture, progress } from './helpers.js';

const cli = join(import.meta.dir, '..', 'src', 'cli.ts');
async function invoke(args: string[], input?: string, explicitScope?: string) {
  const env = { ...process.env };
  delete env.MAGPIE_CONTEXT_FOLDING_SCOPE;
  if (explicitScope !== undefined) env.MAGPIE_CONTEXT_FOLDING_SCOPE = explicitScope;
  const child = Bun.spawn([process.execPath, cli, ...args], { env,
    stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input), stdout: 'pipe', stderr: 'pipe' });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, out, err };
}

test('real hook observations reach read-only statusline, client binding and explicit sessions enumeration', async () => {
  await fixture(async ({ context, store, scope, directory }) => {
    const input = bodyFor('chat');
    const ctx = { ...context, options: { delayRequests: 0 } };
    const output = await onRequest(input, ctx);
    const pending = await invoke(['statusline', '--scope', scope, '--json']);
    assert.equal(pending.code, 0, pending.err);
    const request = JSON.parse(pending.out).request;
    assert.equal(request.status, 'pending');
    assert.equal(request.beforeBytes, Buffer.byteLength(JSON.stringify(input)));
    assert.equal(request.afterBytes, Buffer.byteLength(JSON.stringify(output)));
    assert.equal(request.estimatedTokenDelta, Math.ceil(request.beforeBytes / 4) - Math.ceil(request.afterBytes / 4));
    assert.equal(request.foldedRegions, 1);
    assert.equal(request.replayedReferences, 0);
    assert.equal(request.basis, 'json-utf8-bytes/4');
    assert.ok(request.beforeBytes > request.afterBytes);
    assert.ok(!pending.out.includes(scope));
    assert.ok(!pending.out.includes('requestId'));
    assert.ok(!pending.out.includes('sessionKey'));

    await onResponse({}, { ...ctx, success: true, request: output });
    const path = join(directory, 'state', 'state.sqlite');
    const bytes = await readFile(path);
    const stamp = (await stat(path)).mtimeMs;
    const metrics = (await store.readStats(scope)).metrics;
    const bound = await invoke(['statusline', '--client', '--json'], JSON.stringify({ session_id: context.session, cwd: '/PRIVATE_SECRET' }));
    assert.equal(JSON.parse(bound.out).selection, 'session');
    assert.equal(JSON.parse(bound.out).request.status, 'confirmed');
    assert.ok(!bound.out.includes('PRIVATE_SECRET'));
    const text = await invoke(['statusline', '--scope', scope]);
    assert.match(text.out, /当前会话最近记录.*折叠 1 段.*响应已匹配/);
    assert.match(text.out, /净减少≈\+/);
    assert.ok(!text.out.includes(scope));
    const sessions = await invoke(['sessions', '--json']);
    const session = JSON.parse(sessions.out).sessions[0];
    assert.equal(session.scope, scope);
    assert.equal(session.archivedEntries, 1);
    assert.equal(session.request.status, 'confirmed');
    assert.ok(!sessions.out.includes('sessionKey'));
    assert.ok(!sessions.out.includes('requestId'));
    assert.ok(!sessions.out.includes('这里是已完成'));
    assert.deepEqual(await readFile(path), bytes);
    assert.equal((await stat(path)).mtimeMs, stamp);
    assert.deepEqual((await store.readStats(scope)).metrics, metrics);
    assert.deepEqual(await readdir(join(directory, 'state')), ['state.sqlite']);
  });
});

test('global statusline is explicitly cumulative and never impersonates the newest session', async () => {
  await fixture(async ({ context }) => {
    const ctx = { ...context, options: { delayRequests: 0 } };
    const output = await onRequest(bodyFor('chat'), ctx);
    await onResponse({}, { ...ctx, success: true, request: output });
    const result = await invoke(['statusline']);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /CF 全局累计/);
    assert.ok(!result.out.includes('当前会话'));
    const data = JSON.parse((await invoke(['statusline', '--json'])).out);
    assert.equal(data.selection, 'global-lifetime');
    assert.equal(data.foldCount, 1);
    assert.equal(data.successfulFoldedRequests, 1);
    assert.equal(data.request, undefined);
  });
});

test('client session matching is exact and refuses unknown or ambiguous bindings', async () => {
  await fixture(async ({ context, store, scope }) => {
    await onRequest(bodyFor('chat'), context);
    for (const input of [{}, { session_id: context.session + '-other' }]) {
      const result = await invoke(['statusline', '--client', '--json'], JSON.stringify(input));
      assert.equal(result.code, 0, result.err);
      assert.equal(JSON.parse(result.out).selection, 'unbound');
      assert.ok(!result.out.includes(scope));
    }
    const second = await store.scopeFor('different-origin-same-session');
    const snapshot = await store.transaction(scope, false, 64 * 1024 * 1024, s => structuredClone(s));
    await store.transaction(second, true, 64 * 1024 * 1024, s => { s.decision = snapshot.decision; });
    const ambiguous = await invoke(['statusline', '--client', '--json'], JSON.stringify({ session_id: context.session }));
    assert.deepEqual(JSON.parse(ambiguous.out), { selection: 'unbound', reason: 'ambiguous-session' });
    const explicit = await invoke(['statusline', '--client', '--scope', scope, '--json'], JSON.stringify({ session_id: 'other-client' }));
    assert.equal(JSON.parse(explicit.out).selection, 'session');
    const environment = await invoke(['statusline', '--json'], undefined, scope);
    assert.equal(JSON.parse(environment.out).selection, 'session');
    const preferred = await invoke(['statusline', '--scope', scope, '--json'], undefined, 'f'.repeat(64));
    assert.equal(preferred.code, 0, preferred.err);
  });
});

test('current request counts do not reuse permanent archives and replay reports zero net savings', async () => {
  await fixture(async ({ context, scope, store }) => {
    const input = bodyFor('chat');
    await onRequest(input, context);
    const waiting = JSON.parse((await invoke(['statusline', '--scope', scope, '--json'])).out).request;
    assert.equal(waiting.foldedRegions, 0);
    assert.equal(waiting.waiting, 1);
    assert.equal(waiting.reason, 'annotation-grace-period');
    assert.ok(waiting.estimatedTokenDelta < 0, 'the full request includes the guidance overhead');
    const output = await onRequest(progress(input, 'chat'), context);
    await onResponse({}, { ...context, success: true, request: output });
    const replay = await onRequest(output, context);
    await onResponse({}, { ...context, success: true, request: replay });
    const replayed = JSON.parse((await invoke(['statusline', '--scope', scope, '--json'])).out).request;
    assert.equal(replayed.foldedRegions, 0);
    assert.equal(replayed.replayedReferences, 1);
    assert.equal(replayed.estimatedTokenDelta, 0);
    await onRequest(bodyFor('chat', 'New work; the archived block has left this request.'), context);
    const empty = JSON.parse((await invoke(['statusline', '--scope', scope, '--json'])).out).request;
    assert.equal(empty.foldedRegions, 0);
    assert.equal(empty.replayedReferences, 0);
    assert.equal(empty.reason, 'no-eligible-annotations');
    assert.equal((await store.transaction(scope, false, 64 * 1024 * 1024, s => s.entries.length)), 1);
  });
});

test('legacy observations stay unknown, unknown reasons are redacted, and text blobs are never decoded', async () => {
  await fixture(async ({ context, scope, store, directory }) => {
    await onRequest(bodyFor('chat'), { ...context, options: { delayRequests: 0 } });
    await store.transaction(scope, false, 64 * 1024 * 1024, snapshot => {
      snapshot.decision.reason = '<PRIVATE_SECRET>fake</PRIVATE_SECRET>';
    });
    const redacted = await invoke(['statusline', '--scope', scope, '--json']);
    assert.equal(JSON.parse(redacted.out).request.reason, 'unrecognized');
    assert.ok(!redacted.out.includes('PRIVATE_SECRET'));
    const database = new Database(join(directory, 'state', 'state.sqlite'));
    try {
      database.query('UPDATE blobs SET text = ?').run('PRIVATE_SECRET: deliberately invalid original encoding');
    } finally { database.close(); }
    const stillReadable = await invoke(['statusline', '--scope', scope, '--json']);
    assert.equal(stillReadable.code, 0, stillReadable.err);
    assert.ok(!stillReadable.out.includes('PRIVATE_SECRET'));
    const legacy = new Database(join(directory, 'state', 'state.sqlite'));
    try { legacy.query("UPDATE sessions SET snapshot = json_remove(snapshot, '$.decision.observation') WHERE scope = ?").run(scope); }
    finally { legacy.close(); }
    const unknown = await invoke(['statusline', '--scope', scope, '--json']);
    assert.deepEqual(JSON.parse(unknown.out), { selection: 'session', request: null });
    assert.match((await invoke(['statusline', '--scope', scope])).out, /未记录请求对比/);
  });
});

test('Stop hook notifies the UI once, excludes model context, and rejects stale or unconfirmed observations', async () => {
  await fixture(async ({ context, scope, store, directory }) => {
    const ctx = { ...context, options: { delayRequests: 0 } };
    const output = await onRequest(bodyFor('chat'), ctx);
    const input = JSON.stringify({ session_id: context.session, hook_event_name: 'Stop' });
    assert.deepEqual(JSON.parse((await invoke(['hook'], input)).out), {});
    await assert.rejects(stat(join(directory, 'state', 'ui')), { code: 'ENOENT' });
    await onResponse({}, { ...ctx, success: true, request: output });
    const path = join(directory, 'state', 'state.sqlite');
    const primary = await readFile(path);
    const results = await Promise.all([invoke(['hook'], input), invoke(['hook'], input)]);
    for (const result of results) assert.equal(result.code, 0, result.err);
    const messages = results.map(r => JSON.parse(r.out)).filter(r => r.systemMessage);
    assert.equal(messages.length, 1, 'concurrent Stop notifications claim the request atomically');
    assert.deepEqual(Object.keys(messages[0]), ['systemMessage']);
    assert.match(messages[0].systemMessage, /响应已匹配/);
    assert.deepEqual(await readFile(path), primary, 'notifications do not change archive or statistics');
    assert.equal((await stat(join(directory, 'state', 'ui', 'notifications.sqlite'))).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse((await invoke(['hook'], input)).out), {});
    assert.deepEqual(JSON.parse((await invoke(['hook'], JSON.stringify({ session_id: context.session, hook_event_name: 'PostToolUse' }))).out), {});
    assert.deepEqual(JSON.parse((await invoke(['hook'], JSON.stringify({ session_id: 'unbound', hook_event_name: 'Stop' }))).out), {});
    for (const status of ['failed', 'unverified', 'pending', 'confirmed']) {
      await store.transaction(scope, false, 64 * 1024 * 1024, snapshot => {
        snapshot.decision.observation = { requestId: randomUUID(), observedAt: Date.now() - (status === 'confirmed' ? 360_000 : 0),
          status, sessionKey: digest(context.session) };
      });
      assert.deepEqual(JSON.parse((await invoke(['hook'], input)).out), {}, status);
    }
  });
});

test('Stop hook freshness follows response completion so a long generation can notify when it finishes', async () => {
  await fixture(async ({ context, scope, store }) => {
    const ctx = { ...context, options: { delayRequests: 0 } };
    const output = await onRequest(bodyFor('chat'), ctx);
    const observedAt = Date.now() - 10 * 60_000;
    await store.transaction(scope, false, 64 * 1024 * 1024, snapshot => {
      const observation = snapshot.decision.observation as Record<string, unknown>;
      observation.observedAt = observedAt;
    });
    const completionStarted = Date.now();
    await onResponse({}, { ...ctx, success: true, request: output });
    const request = JSON.parse((await invoke(['statusline', '--scope', scope, '--json'])).out).request;
    assert.equal(request.observedAt, observedAt);
    assert.ok(request.completedAt >= completionStarted);
    const input = JSON.stringify({ session_id: context.session, hook_event_name: 'Stop' });
    const notification = JSON.parse((await invoke(['hook'], input)).out);
    assert.match(notification.systemMessage, /当前会话最近记录.*响应已匹配/);

    const next = await onRequest(bodyFor('chat'), ctx);
    await onResponse({}, { ...ctx, success: true, request: next });
    await store.transaction(scope, false, 64 * 1024 * 1024, snapshot => {
      const observation = snapshot.decision.observation as Record<string, unknown>;
      observation.observedAt = Date.now() - 10 * 60_000;
      observation.completedAt = Date.now() - 6 * 60_000;
    });
    assert.deepEqual(JSON.parse((await invoke(['hook'], input)).out), {}, 'a stale completion does not notify');
  });
});

test('empty installations remain read-only and invalid inputs never echo secrets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'visibility-empty-'));
  const previous = process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
  const state = join(directory, 'absent');
  process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = state;
  try {
    assert.equal(JSON.parse((await invoke(['statusline', '--json'])).out).activeSessions, 0);
    assert.deepEqual(JSON.parse((await invoke(['sessions', '--json'])).out), { sessions: [] });
    assert.equal(JSON.parse((await invoke(['statusline', '--client', '--json'], '{"session_id":"x"}')).out).selection, 'unbound');
    assert.deepEqual(JSON.parse((await invoke(['hook'], '{"session_id":"x","hook_event_name":"Stop"}')).out), {});
    for (const [args, input] of [
      [['statusline', '--scope', 'PRIVATE_SECRET'], undefined],
      [['statusline', '--scope', 'f'.repeat(64)], undefined],
      [['statusline', '--client'], '{PRIVATE_SECRET'],
      [['statusline', '--client'], JSON.stringify({ session_id: { secret: 'PRIVATE_SECRET' } })],
      [['statusline', '--client'], JSON.stringify({ private: 'PRIVATE_SECRET'.repeat(100_000) })],
    ] as [string[], string | undefined][]) {
      const result = await invoke(args, input);
      assert.equal(result.code, 1);
      assert.equal(result.out, '');
      assert.ok(!result.err.includes('PRIVATE_SECRET'));
      assert.ok(result.err.length > 0);
    }
    assert.equal((await invoke(['hook', '--help'])).code, 0);
    await assert.rejects(stat(state), { code: 'ENOENT' });
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
    else process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
