import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { onRequest } from '../src/context.hooks.js';
import { extractSpans, type Protocol } from '../src/protocol.js';

type Body = Record<string, unknown>;
const original = '@context-fold begin evidence\n' + 'Verified earlier evidence: keep the exact identifier available for recovery.\n'.repeat(200) + '@context-fold end evidence';
const canonical = 'exec_command';
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
      options: { delayRequests: 0,
        ...(configured ? { shellToolName: configured } : {}),
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

function assertFolded(body: Body, protocol: Protocol, _name: string): void {
  assert.match(extractSpans(body, protocol).find(span => span.role === 'assistant')?.text ?? '', /\[\[cf:v2:[a-f0-9]{12,64}\]\]/);
  assert.match(JSON.stringify(body), /--dir/);
}

for (const protocol of protocols) {
  test(`${protocol}: folding and replay do not depend on tool names or availability`, async () => {
    await fixture(async (directory, invoke) => {
      for (const changes of [
        { tools: [] }, { tools: undefined },
        { tools: [declaration(protocol, 'arbitrary_host_wrapper')] },
        disabled(protocol), ...restricted(protocol, 'other'),
      ]) {
        const body = { ...request(protocol), ...changes };
        const unchanged = structuredClone(body);
        const output = await invoke(protocol, body);
        assertFolded(output, protocol, '');
        assert.deepEqual(body, unchanged);
        assert.deepEqual(output.tools, body.tools);
        assert.deepEqual(output.tool_choice, body.tool_choice);
        assert.deepEqual(await invoke(protocol, body), output);
        const archives = await readdir(join(directory, 'archive'));
        assert.ok(archives.length > 0);
        assert.ok((await Promise.all(archives.map(file => readFile(join(directory, 'archive', file), 'utf8'))))
          .some(text => text.includes('Verified earlier evidence:')));
      }
    });
  });
}

test('Responses code mode and arbitrary namespaces fold without executor name whitelists', async () => {
  await fixture(async (_directory, invoke) => {
    for (const tools of [
      [{ type: 'custom', name: 'exec' }],
      [{ type: 'custom', name: 'functions.exec' }],
      [{ type: 'namespace', name: 'arbitrary', tools: [{ type: 'custom', name: 'run' }] }],
    ]) {
      const body = { ...request('responses'), tools };
      const output = await invoke('responses', body);
      assertFolded(output, 'responses', '');
      assert.deepEqual(output.tools, tools);
    }
  });
});
