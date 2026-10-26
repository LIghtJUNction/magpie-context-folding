import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { test } from 'node:test';
import { onRequest } from '../src/context.hooks.js';
import { extractSpans } from '../src/protocol.js';
import { Store } from '../src/store.js';
import { execute } from '../src/tool.js';

test('a paused unchanged replay returns the original request after concurrent recovery', { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'folding-hook-conflict-'));
  const previous = process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
  process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = directory;
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  let calls = 0;
  const server = createServer(async (_request, response) => {
    calls++;
    entered.resolve();
    await resume.promise;
    response.end(JSON.stringify({ marks: [] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const body = { model: 'synthetic', tools: [{ type: 'function', function: { name: 'context_folding' } }], messages: [
      { role: 'assistant', content: 'completed evidence\n'.repeat(1200) },
      { role: 'assistant', content: 'unmarked unrelated output '.repeat(300) },
      { role: 'user', content: 'Current requirements.' },
    ] };
    const ctx = { protocol: 'chat', model: 'synthetic', session: 'hook-conflict', cwd: directory,
      options: { thresholdTokens: 1, keepRecentMessages: 1, headChars: 0, policy: { mode: 'bytes' } } };
    await onRequest(body, ctx);
    const store = new Store(directory);
    const scope = await store.scopeFor(JSON.stringify([ctx.session, '', '', directory]));
    const id = extractSpans(body, 'chat')[0]!.id;
    assert.equal(JSON.parse(await execute({ action: 'mark', scope,
      marks: [{ id, disposition: 'foldable', summary: 'Historical checks finished.' }] })).error, undefined);
    const folded = await onRequest(body, ctx);
    assert.ok(extractSpans(folded as Record<string, unknown>, 'chat')[0]!.text.startsWith('[context-folding'));
    const replay = await onRequest(body, ctx);
    assert.ok(isDeepStrictEqual(replay, folded), 'Precondition: unchanged history must replay the same fold');
    const pending = onRequest(body, { ...ctx, options: { ...ctx.options, policy: { mode: 'bytes', autoRoles: ['assistant'], script: {
      command: [process.execPath, '-e', `await Bun.stdin.text(); const r = await fetch('http://127.0.0.1:${address.port}'); process.stdout.write(await r.text());`],
      timeoutMs: 10_000,
    } } } });
    await Promise.race([entered.promise, pending.then(() => { throw new Error('Planning finished without reaching the barrier'); })]);
    assert.equal(JSON.parse(await execute({ action: 'read', scope, id, limit: 1 })).kept, true);
    resume.resolve();
    assert.ok(isDeepStrictEqual(await pending, body), 'A concurrent recovery must retain the complete original request');
    assert.equal(calls, 1);
    const current = await store.transaction(scope, false, 64 * 1024 * 1024, snapshot => snapshot.entries.find(entry => entry.id === id));
    assert.equal(current?.mark.disposition, 'keep');
    assert.equal(current?.folded, undefined);
  } finally {
    resume.resolve();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previous === undefined) delete process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
    else process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
