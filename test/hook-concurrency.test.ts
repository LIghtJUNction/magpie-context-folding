import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onRequest } from '../src/context.hooks.js';
import { execute } from '../src/tool.js';
import { Store, digest } from '../src/store.js';
import { bodyFor, fixture, payload, progress } from './helpers.js';

test('a projection prepared before concurrent recovery returns original input instead of stale folds', async () => {
  await fixture(async ({ context, scope }) => {
    const input = bodyFor('chat');
    await onRequest(input, context);
    let ready!: () => void;
    let release!: () => void;
    const prepared = new Promise<void>(resolve => { ready = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const original = Store.prototype.transaction;
    let pause = true;
    Store.prototype.transaction = function<T>(...args: Parameters<Store['transaction']>): Promise<T> {
      const [scope, create, maxBytes, run, signal, quota] = args;
      return original.call(this, scope, create, maxBytes, async snapshot => {
        const result = await run(snapshot);
        if (create && pause) { pause = false; ready(); await resume; }
        return result;
      }, signal, quota) as Promise<T>;
    };
    try {
      const next = progress(input, 'chat');
      const pending = onRequest(next, context);
      await prepared;
      const read = JSON.parse(await execute({ action: 'read', restore: true, scope, id: digest(payload).slice(0, 12) }));
      assert.equal(read.kept, true);
      release();
      assert.equal(await pending, next, 'failed compare-and-swap cannot publish its stale projection');
    } finally { release(); Store.prototype.transaction = original; }
  });
});
