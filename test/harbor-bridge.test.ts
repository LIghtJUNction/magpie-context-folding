import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { measureNewFoldedRegions } from '../benchmarks/harbor/bridge.js';
import { bodyFor, marked, payload, progress } from './helpers.js';

type Reply = { id: unknown; ok: boolean; result?: any; error?: { code: string; message: string } };
const shellBody = (): Record<string, unknown> => ({ ...bodyFor('chat'), tools: [{ type: 'function', function: { name: 'exec_command',
  parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } } }] });

async function cli(call: (request: Record<string, unknown>) => Promise<Reply>, argv: string[]): Promise<Reply> {
  const reply = await call({ op: 'cli', argv });
  if (reply.ok && reply.result.exit_code === 0) reply.result = JSON.parse(reply.result.stdout);
  return reply;
}

const assistantText = (body: any): string => body.messages.find((message: any) => message.role === 'assistant').content;

async function withBridge(run: (f: {
  directory: string; call: (request: Record<string, unknown>) => Promise<Reply>;
  raw: (line: string) => Promise<Reply>;
}) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'harbor-bridge-'));
  await mkdir(join(directory, '.git'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../benchmarks/harbor/bridge.ts', import.meta.url))], {
    cwd: directory, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HARBOR_FOLDING_SESSION: 'test-trial', HARBOR_FOLDING_CWD: directory,
      MAGPIE_CONTEXT_FOLDING_STATE_DIR: join(directory, 'archive'), XDG_CONFIG_HOME: join(directory, 'config') },
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('exit', code => resolve(code));
    child.once('error', reject);
  });
  const timer = setTimeout(() => { child.kill('SIGKILL'); }, 15000);
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  const raw = async (line: string): Promise<Reply> => {
    child.stdin.write(line + '\n');
    const next = await iterator.next();
    assert.equal(next.done, false, `Bridge ended before response: ${stderr}`);
    return JSON.parse(next.value!) as Reply;
  };
  let id = 0;
  const call = (request: Record<string, unknown>) => raw(JSON.stringify({ id: ++id, ...request }));
  try {
    await run({ directory, call, raw });
    const close = await call({ op: 'close' });
    assert.equal(close.ok, true);
    child.stdin.end();
    assert.equal(await exited, 0, stderr);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill('SIGKILL');
    await exited.catch(() => {});
    lines.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('Harbor bridge drives delayed projection, a real CLI recovery process and completion metrics', async () => {
  await withBridge(async ({ directory, call }) => {
    const original = shellBody();
    const first = await call({ op: 'project', mode: 'folding', body: original });
    assert.equal(first.ok, true);
    assert.match(first.result.scope, /^[a-f0-9]{64}$/);
    assert.equal(assistantText(first.result.body), marked());
    assert.ok(first.result.projection_ms >= 0);
    assert.equal(first.result.input_bytes, Buffer.byteLength(JSON.stringify(original)));
    assert.equal(first.result.assistant_regions_seen, 1);
    assert.deepEqual(first.result.folded_by_role, { assistant: 0, tool: 0 });
    assert.equal((await call({ op: 'response', success: true })).ok, true);

    const retry = await call({ op: 'project', mode: 'folding', body: original });
    assert.equal(assistantText(retry.result.body), marked());
    await call({ op: 'response', success: true });

    const nextBody = progress(original, 'chat');
    const next = await call({ op: 'project', mode: 'folding', body: nextBody });
    assert.equal(next.ok, true);
    const compact = assistantText(next.result.body);
    const hash = compact.match(/\[\[cf:v2:([a-f0-9]{12,64})\]\]/)?.[1];
    assert.ok(hash);
    assert.equal(next.result.folded_by_role.assistant, 1);
    assert.equal(next.result.folded_by_role.tool, 0);
    assert.ok(next.result.output_bytes < next.result.input_bytes);
    // The bridge did not mutate the parent's authoritative original transcript.
    assert.equal((original.messages as any[])[2].content, marked());
    await call({ op: 'response', success: true });

    const status = await cli(call, ['status', '--state-dir', join(directory, 'archive')]);
    assert.equal(status.result.metrics.successfulHookRequests, 3);
    assert.equal(status.result.metrics.successfulFoldedRequests, 1);
    assert.equal(status.result.metrics.itemsFolded, 1);
    const recovered = await cli(call, ['read', '--id', hash!, '--limit', '24000', '--json']);
    assert.equal(recovered.result.text, payload);
    assert.equal(recovered.result.kept, false);
    assert.equal(recovered.result.nextOffset, null);

    const kept = await call({ op: 'project', mode: 'folding', body: progress(nextBody, 'chat') });
    assert.equal(assistantText(kept.result.body), compact);
    await call({ op: 'response', success: true });
    const restored = await cli(call, ['read', '--id', hash!, '--restore', '--json']);
    assert.equal(restored.result.kept, true);
    assert.equal(restored.result.text, payload);
    const expanded = await call({ op: 'project', mode: 'folding', body: progress(nextBody, 'chat') });
    assert.equal(assistantText(expanded.result.body), marked());
    await call({ op: 'response', success: true });
  });
});

test('Harbor fold attribution distinguishes assistant notes from verified source reads', () => {
  const assistant = bodyFor('chat');
  const assistantProjection = structuredClone(assistant) as any;
  assistantProjection.messages.find((message: any) => message.role === 'assistant').content = '[[cf:v2:123456789abc]]';
  assert.deepEqual(measureNewFoldedRegions(assistant, assistantProjection), { assistant: 1, tool: 0 });

  const source = {
    model: 'fixture',
    tools: [{ type: 'function', function: { name: 'read_file' } }],
    messages: [
      { role: 'assistant', content: null, tool_calls: [{ id: 'read-1', type: 'function',
        function: { name: 'read_file', arguments: '{"path":"src/note.ts"}' } }] },
      { role: 'tool', tool_call_id: 'read-1', content: marked(payload, 'source') },
      { role: 'assistant', content: 'Read complete.' },
      { role: 'user', content: 'Continue.' },
    ],
  };
  const sourceProjection = structuredClone(source) as any;
  sourceProjection.messages.find((message: any) => message.role === 'tool').content = '[[cf:v2:abcdef123456]]';
  assert.deepEqual(measureNewFoldedRegions(source, sourceProjection), { assistant: 0, tool: 1 });
});

test('Harbor bridge counts assistant annotations in the final transcript', async () => {
  await withBridge(async ({ call }) => {
    const body = bodyFor('chat');
    const inspected = await call({ op: 'inspect', messages: body.messages });
    assert.deepEqual(inspected.result, { assistant_authored_regions: 1 });
  });
});

test('Harbor terminal wrapper drives real folding without a dummy shell declaration', async () => {
  await withBridge(async ({ call }) => {
    const body = { ...shellBody(), tools: [{ type: 'function', function: { name: 'terminal',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } }] };
    const first = await call({ op: 'project', mode: 'folding', body });
    assert.equal(first.ok, true);
    assert.match(first.result.scope, /^[a-f0-9]{64}$/);
    await call({ op: 'response', success: true });
    const next = await call({ op: 'project', mode: 'folding', body: progress(body, 'chat') });
    assert.match(assistantText(next.result.body), /\[\[cf:v2:[0-9a-f]+\]\]/);
    assert.deepEqual(next.result.body.tools, body.tools);
    await call({ op: 'response', success: true });
  });
});

test('Harbor baseline remains byte-identical and never creates a folding archive', async () => {
  await withBridge(async ({ directory, call }) => {
    const body = shellBody();
    const baseline = await call({ op: 'project', mode: 'baseline', body });
    assert.equal(baseline.ok, true);
    assert.deepEqual(baseline.result.body, body);
    assert.equal(baseline.result.scope, null);
    assert.equal(baseline.result.input_bytes, baseline.result.output_bytes);
    await call({ op: 'response', success: false });
    assert.equal(existsSync(join(directory, 'archive', 'state.sqlite')), false);
    assert.equal((await cli(call, ['status'])).error?.code, 'archive_unavailable');
    assert.equal((await call({ op: 'project', mode: 'folding', body })).error?.code, 'mode_changed');
  });
});

test('Harbor recovery cannot write to the host or read another trial scope', async () => {
  await withBridge(async ({ call }) => {
    await call({ op: 'project', mode: 'folding', body: shellBody() });
    await call({ op: 'response', success: true });
    for (const action of ['paste', 'forget', 'stats', 'mark']) {
      const denied = await call({ op: 'cli', argv: [action, '--path', '/tmp/forbidden'] });
      assert.equal(denied.error?.code, 'unsupported_action');
    }
    const other = await call({ op: 'cli', argv: ['status', '--scope', 'f'.repeat(64)] });
    assert.equal(other.error?.code, 'scope_mismatch');
    const otherDirectory = await call({ op: 'cli', argv: ['status', '--state-dir=/tmp/other-trial'] });
    assert.equal(otherDirectory.error?.code, 'scope_mismatch');
    const otherEqualsScope = await call({ op: 'cli', argv: ['status', '--scope=' + 'f'.repeat(64)] });
    assert.equal(otherEqualsScope.error?.code, 'scope_mismatch');
    const invalidArgs = await call({ op: 'cli', argv: ['status', '--path', '/tmp/forbidden'] });
    assert.equal(invalidArgs.result.exit_code, 1);
    assert.match(invalidArgs.result.stderr, /Invalid command options/);
    const status = await cli(call, ['status']);
    assert.equal(status.ok, true);
    assert.equal(status.result.entries, 1);
  });
});

test('Harbor JSONL protocol survives bad input and enforces one completion per request', async () => {
  await withBridge(async ({ call, raw }) => {
    const malformed = await raw('{this-is-not-json');
    assert.equal(malformed.id, null);
    assert.equal(malformed.error?.code, 'invalid_json');
    assert.equal((await call({ op: 'response', success: true })).error?.code, 'no_request');
    const body = shellBody();
    await call({ op: 'project', mode: 'folding', body });
    assert.equal((await call({ op: 'project', mode: 'folding', body })).error?.code, 'request_pending');
    assert.equal((await cli(call, ['status'])).error?.code, 'request_pending');
    assert.equal((await call({ op: 'response', success: 'true' })).error?.code, 'invalid_request');
    assert.equal((await call({ op: 'response', success: false })).ok, true);
    assert.equal((await call({ op: 'response', success: false })).error?.code, 'no_request');
    const status = await cli(call, ['status']);
    assert.equal(status.result.metrics.failedHookRequests, 1);
    assert.equal(status.result.metrics.successfulHookRequests, 0);
  });
});
