import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture } from './helpers.js';

async function command(body: unknown, range: unknown, scope: string, json = false) {
  const process = Bun.spawn([Bun.which('bun') ?? globalThis.process.execPath, 'src/cli.ts', 'fold-messages', '--scope', scope,
    '--range', JSON.stringify(range), ...(json ? ['--json'] : [])], {
    stdin: new TextEncoder().encode(JSON.stringify(body)), stdout: 'pipe', stderr: 'pipe', env: globalThis.process.env,
  });
  const [code, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
  return { code, stdout, stderr };
}

test('CLI folds a middle fragment by code points, preserving both outside slices and metadata', async () => {
  await fixture(async ({ scope }) => {
    const body = { model: 'fixture', messages: [{ role: 'assistant', name: 'writer', content: '前😀abcdef后' }] };
    const result = await command(body, { start: { message: 0, offset: 2 }, end: { message: 0, offset: 5 } }, scope, true);
    assert.equal(result.code, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.deepEqual(value.body.messages[0], { role: 'assistant', name: 'writer', content: '前😀' });
    assert.equal(value.body.messages[1].role, 'user');
    assert.deepEqual(value.body.messages[2], { role: 'assistant', name: 'writer', content: 'def后' });
    assert.ok((await readFile(value.references[0].path, 'utf8')).endsWith('abc'));
    const lines = (await readFile(value.references[0].transcriptPath, 'utf8')).trim().split('\n');
    assert.deepEqual(JSON.parse(lines[1]!).original, body.messages[0]);
  });
});

test('CLI folds the first N messages to one user message without any advance markers', async () => {
  await fixture(async ({ scope }) => {
    const body = { messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'second' }, { role: 'assistant', content: 'answer2' }, { role: 'user', content: 'current' }] };
    const result = await command(body, { start: { message: 0 }, end: { message: 4 } }, scope);
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.messages.length, 2);
    assert.equal(output.messages[0].role, 'user');
    assert.match(output.messages[0].content, /\[\[cf:v3:/);
    assert.deepEqual(output.messages[1], body.messages[4]);
  });
});

test('invalid ranges and split tool exchanges produce no partial stdout', async () => {
  await fixture(async ({ scope }) => {
    const body = { messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'exec', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c', content: 'result' }] };
    for (const range of [{ start: { message: 0 }, end: { message: 1 } }, { start: { message: 3 }, end: { message: 1 } }]) {
      const result = await command(body, range, scope);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, '');
      assert.ok(result.stderr);
    }
  });
});
