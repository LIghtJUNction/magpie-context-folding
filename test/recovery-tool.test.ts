import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { onRequest } from '../src/context.hooks.js';
import { extractSpans, type Protocol } from '../src/protocol.js';

type Body = Record<string, unknown>;
const original = 'Verified earlier evidence: keep the exact identifier available for recovery.\n'.repeat(200);
const canonical = 'context_folding';
const mcpName = 'mcp__magpie__magpie_context_folding_context_folding';
const protocols: Protocol[] = ['chat', 'responses', 'anthropic', 'gemini'];

function declaration(protocol: Protocol, name: string, extra: Body = {}): Body {
  const parameters = { type: 'object', properties: {} };
  if (protocol === 'chat') return { type: 'function', function: { name, parameters, ...extra } };
  if (protocol === 'responses') return { type: 'function', name, parameters, ...extra };
  if (protocol === 'anthropic') return { name, input_schema: parameters, ...extra };
  return { functionDeclarations: [{ name, parameters, ...extra }] };
}

function request(protocol: Protocol, name = canonical, extra: Body = {}): Body {
  const tools = [declaration(protocol, name, extra), declaration(protocol, 'other')];
  if (protocol === 'responses') return { tools, input: [
    { role: 'assistant', content: [{ type: 'output_text', text: original }] },
    { role: 'user', content: [{ type: 'input_text', text: 'Continue.' }] },
  ] };
  if (protocol === 'gemini') return { tools, contents: [
    { role: 'model', parts: [{ text: original }] }, { role: 'user', parts: [{ text: 'Continue.' }] },
  ] };
  return { tools, messages: [{ role: 'assistant', content: original }, { role: 'user', content: 'Continue.' }] };
}

function disabled(protocol: Protocol): Body {
  if (protocol === 'gemini') return { toolConfig: { functionCallingConfig: { mode: 'NONE' } } };
  return { tool_choice: protocol === 'anthropic' ? { type: 'none' } : 'none' };
}

function restricted(protocol: Protocol, name: string): Body[] {
  if (protocol === 'chat') return [
    { tool_choice: { type: 'function', function: { name } } },
    { tool_choice: { type: 'allowed_tools', allowed_tools: {
      mode: 'auto', tools: [{ type: 'function', function: { name } }],
    } } },
  ];
  if (protocol === 'responses') return [
    { tool_choice: { type: 'function', name } },
    { tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name }] } },
  ];
  if (protocol === 'anthropic') return [{ tool_choice: { type: 'tool', name } }];
  return ['ANY', 'VALIDATED'].map(mode => ({ toolConfig: {
    functionCallingConfig: { mode, allowedFunctionNames: [name] },
  } }));
}

async function fixture(run: (directory: string, invoke: (protocol: Protocol, body: Body, configured?: string) => Promise<Body>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'folding-recovery-tool-'));
  const previous = { state: process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR, config: process.env.XDG_CONFIG_HOME };
  process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = directory;
  process.env.XDG_CONFIG_HOME = join(directory, 'config');
  try {
    await run(directory, async (protocol, body, configured) => await onRequest(body, {
      protocol, model: 'synthetic', session: protocol, cwd: directory,
      options: { thresholdTokens: 1, keepRecentMessages: 1, headChars: 0,
        ...(configured ? { recoveryToolName: configured } : {}),
        policy: { mode: 'bytes', autoRoles: ['assistant'], minChars: 1, summaryChars: 256 },
      },
    }) as Body);
  } finally {
    if (previous.state === undefined) delete process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
    else process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = previous.state;
    if (previous.config === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous.config;
    await rm(directory, { recursive: true, force: true });
  }
}

function assertOriginal(body: Body, protocol: Protocol): void {
  assert.equal(extractSpans(body, protocol).find(span => span.role === 'assistant')?.text, original);
  assert.ok(!JSON.stringify(body).includes('<context-folding scope='));
}

function assertFolded(body: Body, protocol: Protocol, name: string): void {
  assert.match(extractSpans(body, protocol).find(span => span.role === 'assistant')?.text ?? '', /^\[context-folding id=/);
  const guide = extractSpans(body, protocol).at(-1)!.text;
  assert.ok(guide.includes(`tools[${JSON.stringify(name)}]`), 'the guide must name the actual recovery tool');
}

for (const protocol of protocols) {
  test(`${protocol}: mentions and similar tool names do not advertise recovery`, async () => {
    await fixture(async (directory, invoke) => {
      for (const body of [
        request(protocol, 'other', { description: 'Use context_folding only if installed.' }),
        request(protocol, 'other', { [protocol === 'anthropic' ? 'input_schema' : 'parameters']:
          { type: 'object', properties: { context_folding: { type: 'string' } } } }),
        request(protocol, 'not_context_folding'), request(protocol, 'context_folding_extra'),
        request(protocol, 'mcp__other__context_folding'),
      ]) {
        assertOriginal(await invoke(protocol, body), protocol);
        assert.deepEqual(await readdir(directory), [], 'unavailable recovery must not create an archive');
      }
    });
  });

  test(`${protocol}: disabled or excluded recovery leaves the original visible`, async () => {
    await fixture(async (directory, invoke) => {
      for (const choice of [disabled(protocol), ...restricted(protocol, 'other')]) {
        assertOriginal(await invoke(protocol, { ...request(protocol), ...choice }), protocol);
        assert.deepEqual(await readdir(directory), []);
      }
    });
  });

  test(`${protocol}: real declarations and allowed choices keep recovery usable`, async () => {
    await fixture(async (_directory, invoke) => {
      for (const name of [canonical, mcpName]) {
        for (const choice of [{}, ...restricted(protocol, name)]) {
          const body = { ...request(protocol, name), ...choice };
          const unchanged = structuredClone(body);
          assertFolded(await invoke(protocol, body), protocol, name);
          assert.deepEqual(body, unchanged);
        }
      }
    });
  });

  test(`${protocol}: disabling recovery also suspends replay and re-enabling restores it`, async () => {
    await fixture(async (_directory, invoke) => {
      const body = request(protocol);
      const first = await invoke(protocol, body);
      assertFolded(first, protocol, canonical);
      assertOriginal(await invoke(protocol, { ...body, ...disabled(protocol) }), protocol);
      assert.deepEqual(await invoke(protocol, body), first);
    });
  });

  test(`${protocol}: explicit wrapped recovery respects global tool disabling`, async () => {
    await fixture(async (directory, invoke) => {
      const body = request(protocol, 'exec');
      assertOriginal(await invoke(protocol, { ...body, ...disabled(protocol) }, mcpName), protocol);
      assert.deepEqual(await readdir(directory), []);
      for (const choice of [{}, ...restricted(protocol, 'exec')]) {
        assertFolded(await invoke(protocol, { ...body, ...choice }, mcpName), protocol, mcpName);
      }
    });
  });
}

test('Gemini SDK config uses actual function declarations and calling restrictions', async () => {
  await fixture(async (directory, invoke) => {
    const body = request('gemini');
    const { tools, ...contents } = body;
    const config = { tools, toolConfig: { functionCallingConfig: { mode: 'NONE' } } };
    assertOriginal(await invoke('gemini', { ...contents, config }), 'gemini');
    assert.deepEqual(await readdir(directory), []);
    assertFolded(await invoke('gemini', { ...contents, config: { tools } }), 'gemini', canonical);
  });
});
