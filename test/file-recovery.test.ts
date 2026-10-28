import assert from 'node:assert/strict';
import { readFile, readdir, stat, unlink, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { onRequest } from '../src/context.hooks.js';
import { withoutBudget } from '../src/budget.js';
import { extractSpans, type Protocol } from '../src/protocol.js';
import { bodyFor, fixture, payload } from './helpers.js';
import { execute } from '../src/tool.js';

function fileReference(body: Record<string, unknown>, protocol: Protocol) {
  const span = extractSpans(body, protocol).find(item => item.text.includes('[[cf:v3:'));
  assert.ok(span);
  const match = /\[\[cf:v3:([a-f0-9]{12,64}) path=("(?:[^"\\]|\\.)*")\]\]/.exec(span.text);
  assert.ok(match);
  return { span, hash: match[1]!, path: JSON.parse(match[2]!) as string };
}

for (const protocol of ['chat', 'responses', 'anthropic', 'gemini'] as Protocol[]) {
  test(`${protocol}: one user reference and exact readable files require no recovery service`, async () => {
    await fixture(async ({ context }) => {
      const input = bodyFor(protocol);
      delete input.tools;
      const original = structuredClone(input);
      const output = await onRequest(input, { ...context, options: { delayRequests: 0 } }) as Record<string, unknown>;
      const { span, path } = fileReference(output, protocol);
      assert.equal(span.role, 'user');
      assert.equal(extractSpans(output, protocol).filter(item => item.text.includes('[[cf:v3:')).length, 1);
      assert.ok((await readFile(path, 'utf8')).includes(payload));
      const transcript = (await readFile(path.replace(/\.messages\.txt$/, '.jsonl'), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
      assert.equal(transcript[0].protocol, protocol);
      assert.equal(transcript[1].original.role, protocol === 'gemini' ? 'model' : 'assistant');
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.match(span.text, /lightweight subagent/);
      assert.match(span.text, /rg\/grep/);
      assert.deepEqual(input, original);
      assert.equal(output.tools, undefined);
    }, protocol);
  });

  test(`${protocol}: disabled provider tools do not disable ordinary file recovery`, async () => {
    await fixture(async ({ context }) => {
      const input = { ...bodyFor(protocol), tool_choice: 'none', toolConfig: { functionCallingConfig: { mode: 'NONE' } } };
      const output = await onRequest(input, { ...context, options: { delayRequests: 0 } }) as Record<string, unknown>;
      const { path } = fileReference(output, protocol);
      assert.ok((await readFile(path, 'utf8')).includes(payload));
    }, protocol);
  });
}

test('hosts without shared filesystem access retain original history', async () => {
  await fixture(async ({ context, directory }) => {
    const input = bodyFor('chat');
    const output = await onRequest(input, { ...context, options: { delayRequests: 0, fileAccess: false } }) as Record<string, unknown>;
    assert.deepEqual(withoutBudget(output, 'chat'), input);
    assert.ok(!(await readdir(join(directory, 'state'))).includes('archives'));
  });
});

test('an altered immutable file cannot publish a broken reference or overwrite its contents', async () => {
  await fixture(async ({ context, store, scope }) => {
    const input = bodyFor('chat');
    const opts = { ...context, options: { delayRequests: 0 } };
    const output = await onRequest(input, opts) as Record<string, unknown>;
    const { path } = fileReference(output, 'chat');
    const before = await store.readStats(scope);
    await writeFile(path, 'modified externally');
    assert.equal(await onRequest(input, opts), input);
    assert.equal(await readFile(path, 'utf8'), 'modified externally');
    assert.deepEqual(await store.readStats(scope), before);
  });
});

test('missing files are rebuilt from the durable index before a replay escapes', async () => {
  await fixture(async ({ context }) => {
    const input = bodyFor('chat');
    const opts = { ...context, options: { delayRequests: 0 } };
    const output = await onRequest(input, opts) as Record<string, unknown>;
    const { path } = fileReference(output, 'chat');
    const text = await readFile(path, 'utf8');
    await unlink(path);
    const next = await onRequest(input, opts) as Record<string, unknown>;
    assert.equal(fileReference(next, 'chat').path, path);
    assert.equal(await readFile(path, 'utf8'), text);
  });
});

test('archive directory symlinks cause a fail-open request without exposing a reference', async () => {
  await fixture(async ({ context, directory }) => {
    const input = bodyFor('chat');
    await symlink(directory, join(directory, 'state', 'archives'));
    assert.equal(await onRequest(input, { ...context, options: { delayRequests: 0 } }), input);
  });
});

test('reading a saved archive with an ordinary file tool never folds its historical markers again', async () => {
  await fixture(async ({ context, directory }) => {
    const output = await onRequest(bodyFor('chat'), { ...context, options: { delayRequests: 0 } }) as Record<string, unknown>;
    const { path } = fileReference(output, 'chat');
    const original = await readFile(path, 'utf8');
    const input = { messages: [
      { role: 'assistant', tool_calls: [{ id: 'recover', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path }) } }] },
      { role: 'tool', tool_call_id: 'recover', content: original }, { role: 'user', content: 'Extract the relevant detail.' },
    ] };
    const replay = await onRequest(input, { ...context, options: { delayRequests: 0 } }) as Record<string, unknown>;
    assert.deepEqual(withoutBudget(replay, 'chat'), input);
    const alias = join(directory, 'historical-notes.txt');
    await symlink(path, alias);
    input.messages[0]!.tool_calls![0]!.function.arguments = JSON.stringify({ path: alias });
    const aliasReplay = await onRequest(input, { ...context, options: { delayRequests: 0 } }) as Record<string, unknown>;
    assert.deepEqual(withoutBudget(aliasReplay, 'chat'), input);
  });
});

test('CLI recovery still returns indexed originals if file publication is unavailable', async () => {
  await fixture(async ({ context, scope }) => {
    const output = await onRequest(bodyFor('chat'), { ...context, options: { delayRequests: 0 } }) as Record<string, unknown>;
    const { hash, path } = fileReference(output, 'chat');
    const original = await readFile(path, 'utf8');
    await writeFile(path, 'externally altered');
    const read = JSON.parse(await execute({ action: 'read', scope, id: hash, limit: 24000 }));
    assert.equal(read.text, original);
    assert.equal(read.kept, true);
    assert.equal(read.fileStatus, 'unavailable');
    assert.equal(read.path, undefined);
    assert.equal(read.transcriptPath, undefined);
    assert.equal(await readFile(path, 'utf8'), 'externally altered');
    const list = JSON.parse(await execute({ action: 'list', scope }));
    assert.equal(list.error, undefined);
    assert.ok(list.entries.length > 0, 'the intact index remains searchable when exported files are unavailable');
    assert.equal(JSON.parse(await execute({ action: 'status', scope })).error, undefined);
  });
});
