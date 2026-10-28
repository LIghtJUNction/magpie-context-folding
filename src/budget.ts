import type { Protocol } from './protocol.js';

export function estimateTokens(body: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(body)) / 4);
}

type Body = Record<string, unknown>;
const record = (value: unknown): value is Body => !!value && typeof value === 'object' && !Array.isArray(value);
const budget = /^<context-budget used_estimate=\d+ capacity=(?:\d+|unknown) output_reserved=\d+ available_estimate=(?:\d+|unknown) basis=json-utf8-bytes\/4(?: scope=[a-f0-9]{64})?\s*\/>$/;
const isBudget = (value: unknown): boolean => typeof value === 'string' && budget.test(value);
function stripBudgetText(text: string): string {
  // Hosts may join text blocks or append instructions after our metadata.
  const paragraphs = text.split('\n\n').filter(part => !isBudget(part));
  return paragraphs.map(part => part.split('\n').filter(line => !isBudget(line)).join('\n')).join('\n\n');
}

/** Replace only our own system metadata, never remove marker-looking user text. */
export function withoutBudget(body: Body, protocol: Protocol): Body {
  const result = structuredClone(body);
  if (protocol === 'chat' && Array.isArray(result.messages)) {
    result.messages = result.messages.filter(item => !(record(item) && item.role === 'system' && isBudget(item.content)));
  } else if (protocol === 'responses' && typeof result.instructions === 'string') {
    const instructions = stripBudgetText(result.instructions);
    if (instructions) result.instructions = instructions;
    else delete result.instructions;
  } else if (protocol === 'anthropic') {
    if (Array.isArray(result.system)) {
      result.system = result.system.filter(part => !(record(part) && part.type === 'text' && isBudget(part.text)));
      if (!(result.system as unknown[]).length) delete result.system;
    } else if (typeof result.system === 'string') {
      const system = stripBudgetText(result.system);
      if (system) result.system = system;
      else delete result.system;
    }
  } else if (protocol === 'gemini') {
    const holder = record(result.config) ? result.config : result;
    for (const key of ['systemInstruction', 'system_instruction']) {
      const instruction = holder[key];
      if (record(instruction) && Array.isArray(instruction.parts)) {
        instruction.parts = instruction.parts.filter(part => !(record(part) && isBudget(part.text)));
        if (!(instruction.parts as unknown[]).length) delete holder[key];
      }
    }
  }
  return result;
}

function addSystemBudget(body: Body, text: string, protocol: Protocol): Body {
  const result = structuredClone(body);
  if (protocol === 'chat') {
    if (!Array.isArray(result.messages)) return result;
    result.messages.unshift({ role: 'system', content: text });
  } else if (protocol === 'responses') {
    if (result.instructions !== undefined && typeof result.instructions !== 'string') return result;
    result.instructions = result.instructions ? `${result.instructions}\n\n${text}` : text;
  } else if (protocol === 'anthropic') {
    if (result.system !== undefined && typeof result.system !== 'string' && !Array.isArray(result.system)) return result;
    if (typeof result.system === 'string') result.system = `${result.system}\n\n${text}`;
    else result.system = [...(result.system ?? []) as unknown[], { type: 'text', text }];
  } else {
    const holder = record(result.config) ? result.config : result;
    const key = Object.hasOwn(holder, 'system_instruction') ? 'system_instruction' : 'systemInstruction';
    const previous = holder[key];
    if (previous !== undefined && (!record(previous) || !Array.isArray(previous.parts))) return result;
    holder[key] = { ...(record(previous) ? previous : {}), parts: [...(record(previous) ? previous.parts as unknown[] : []), { text }] };
  }
  return result;
}

export interface BudgetOptions { contextWindowTokens?: number; reserveOutputTokens?: number; scope?: string }

/** Unknown model capacity stays unknown. This estimate is never a billing claim. */
export function appendBudget(body: Body, protocol: Protocol, options: BudgetOptions = {}): Body {
  const clean = withoutBudget(body, protocol);
  const render = (used: number) => {
    const reserved = options.reserveOutputTokens ?? 0;
    const available = options.contextWindowTokens === undefined ? 'unknown' : Math.max(0, options.contextWindowTokens - used - reserved);
    const hint = `<context-budget used_estimate=${used} capacity=${options.contextWindowTokens ?? 'unknown'} output_reserved=${reserved} available_estimate=${available} basis=json-utf8-bytes/4${options.scope ? ` scope=${options.scope}` : ''} />`;
    return addSystemBudget(clean, hint, protocol);
  };
  let used = estimateTokens(clean);
  for (let iteration = 0; iteration < 16; iteration++) {
    const output = render(used);
    const next = estimateTokens(output);
    if (next === used) return output;
    used = next;
  }
  return render(used);
}
