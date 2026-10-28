import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import type { Protocol } from '../src/protocol.js';

export const payload = '这里是已完成的可回查过程。emoji ✅ and exact text.\n'.repeat(60).trimEnd();
export const marked = (text = payload, style: 'prose' | 'source' = 'prose') => style === 'prose'
  ? `<!-- @context-fold begin research -->\n${text}\n<!-- @context-fold end research -->`
  : `// @context-fold begin research\n${text}\n// @context-fold end research`;

export async function fixture(run: (f: {
  directory: string; store: Store; scope: string;
  context: { protocol: Protocol; model: string; session: string; cwd: string; state: Record<string, unknown> };
}) => Promise<void>, protocol: Protocol = 'chat') {
  const directory = await mkdtemp(join(tmpdir(), 'annotation-folding-'));
  const previousState = process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
  const previousConfig = process.env.XDG_CONFIG_HOME;
  process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = join(directory, 'state');
  process.env.XDG_CONFIG_HOME = join(directory, 'config');
  await mkdir(join(directory, '.git'));
  const store = new Store();
  const context = { protocol, model: 'fixture', session: 'annotations', cwd: directory, state: {} };
  const scope = await store.scopeFor(JSON.stringify([context.session, '', '', directory]));
  try { await run({ directory, store, scope, context }); }
  finally {
    if (previousState === undefined) delete process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
    else process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = previousState;
    if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfig;
    await rm(directory, { recursive: true, force: true });
  }
}

export function bodyFor(protocol: Protocol, text = marked()): Record<string, unknown> {
  if (protocol === 'chat') return {
    model: 'fixture', tools: [{ type: 'function', function: { name: 'context_folding' } }],
    messages: [{ role: 'system', content: 'Original requirements.' }, { role: 'user', content: 'Start.' },
      { role: 'assistant', content: text }, { role: 'user', content: 'Continue.' }],
  };
  if (protocol === 'responses') return {
    model: 'fixture', instructions: 'Original requirements.', tools: [{ type: 'function', name: 'context_folding' }],
    input: [{ role: 'user', content: 'Start.' }, { role: 'assistant', content: [{ type: 'output_text', text }] },
      { role: 'user', content: [{ type: 'input_text', text: 'Continue.' }] }],
  };
  if (protocol === 'anthropic') return {
    model: 'fixture', system: [{ type: 'text', text: 'Original requirements.', cache_control: { type: 'ephemeral' } }],
    tools: [{ name: 'context_folding', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'Start.' }, { role: 'assistant', content: [{ type: 'text', text }] },
      { role: 'user', content: 'Continue.' }],
  };
  return {
    contents: [{ role: 'user', parts: [{ text: 'Start.' }] }, { role: 'model', parts: [{ text }] },
      { role: 'user', parts: [{ text: 'Continue.' }] }],
    tools: [{ functionDeclarations: [{ name: 'context_folding' }] }],
    systemInstruction: { parts: [{ text: 'Original requirements.' }] },
  };
}

export function progress(body: Record<string, unknown>, protocol: Protocol): Record<string, unknown> {
  const result = structuredClone(body);
  const key = protocol === 'responses' ? 'input' : protocol === 'gemini' ? 'contents' : 'messages';
  (result[key] as unknown[]).push(protocol === 'gemini' ? { role: 'user', parts: [{ text: 'A new step.' }] }
    : { role: 'user', content: 'A new step.' });
  return result;
}
