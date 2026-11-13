import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Protocol } from './protocol.js';

type Body = Record<string, unknown>;
const record = (value: unknown): value is Body => !!value && typeof value === 'object' && !Array.isArray(value);
const tag = '<context-folding>[\\s\\S]*?<\\/context-folding>';
function strip(text: string): string {
  // Remove exactly the separator we inserted, rather than splitting paragraphs:
  // the host's own trailing newlines must survive repeated projections.
  const clean = text.replace(new RegExp(`(?:\\r?\\n){1,2}${tag}(?:\\r?\\n(?=$))?(?=\\r?\\n|$)`, 'g'), '');
  return clean.replace(new RegExp(`^${tag}(?:\\r?\\n){0,2}`), '');
}

/** POSIX shell argument quoting; generated paths must never become shell code. */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
export const defaultRecoveryCommand = (): string => `${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(new URL('./cli.ts', import.meta.url)))}`;

function cleanParts(parts: unknown[]): unknown[] {
  return parts.flatMap(part => {
    if (!record(part) || typeof part.text !== 'string') return [part];
    const text = strip(part.text);
    return text || text === part.text ? [{ ...part, text }] : [];
  });
}

function taggedText(value: unknown): boolean {
  return typeof value === 'string' && /<context-folding>[\s\S]*?<\/context-folding>/.test(value);
}

function taggedParts(value: unknown): boolean {
  return Array.isArray(value) && value.some(part => record(part) && taggedText(part.text));
}

/** Detect prior plugin guidance in system fields without scanning user text. */
export function containsGuidance(body: Body, protocol: Protocol): boolean {
  if (protocol === 'chat' && Array.isArray(body.messages)) {
    return body.messages.some(item => record(item) && ['system', 'developer'].includes(String(item.role))
      && (taggedText(item.content) || taggedParts(item.content)));
  }
  if (protocol === 'responses') return taggedText(body.instructions);
  if (protocol === 'anthropic') return taggedText(body.system) || taggedParts(body.system);
  const holders = [body, ...(record(body.config) ? [body.config] : [])];
  return holders.some(holder => ['systemInstruction', 'system_instruction'].some(key => {
    const instruction = holder[key];
    return taggedText(instruction) || record(instruction) && taggedParts(instruction.parts);
  }));
}

/** Remove only our tagged system instructions, including host-flattened copies. */
export function stripGuidanceInPlace(result: Body, protocol: Protocol): void {
  if (protocol === 'chat' && Array.isArray(result.messages)) {
    result.messages = result.messages.flatMap(item => {
      if (!record(item) || !['system', 'developer'].includes(String(item.role))) return [item];
      if (typeof item.content === 'string') {
        const content = strip(item.content);
        return content || content === item.content ? [{ ...item, content }] : [];
      }
      if (Array.isArray(item.content)) {
        const content = cleanParts(item.content);
        return content.length || !item.content.length ? [{ ...item, content }] : [];
      }
      return [item];
    });
  } else if (protocol === 'responses' && typeof result.instructions === 'string') {
    const text = strip(result.instructions);
    if (text || text === result.instructions) result.instructions = text;
    else delete result.instructions;
  } else if (protocol === 'anthropic') {
    if (typeof result.system === 'string') {
      // Undefined systems are injected as arrays, so a string stays a string
      // even when it originally contained no text.
      result.system = strip(result.system);
    } else if (Array.isArray(result.system)) {
      const parts = cleanParts(result.system);
      if (parts.length || !result.system.length) result.system = parts;
      else delete result.system;
    }
  } else if (protocol === 'gemini') {
    // The REST and SDK request forms use different holders and naming styles.
    for (const holder of [result, ...(record(result.config) ? [result.config] : [])]) {
      for (const key of ['systemInstruction', 'system_instruction']) {
        const instruction = holder[key];
        if (typeof instruction === 'string') {
          holder[key] = strip(instruction);
        } else if (record(instruction) && Array.isArray(instruction.parts)) {
          const parts = cleanParts(instruction.parts);
          // New containers use camelCase in config when present. Preserve
          // identifiable host holders so replay cannot rename or move them.
          if (parts.length || !instruction.parts.length || key === 'system_instruction'
            || (holder === result && record(result.config))
            || Object.keys(instruction).some(key => key !== 'parts')) {
            holder[key] = { ...instruction, parts };
          }
          else delete holder[key];
        }
      }
    }
  }
}

export function withoutGuidance(body: Body, protocol: Protocol): Body {
  const result = structuredClone(body);
  stripGuidanceInPlace(result, protocol);
  return result;
}

export interface GuidanceOptions { command: string; minSavingsTokens?: number; scope?: string; stateDirectory?: string }

export function guidanceText(options: GuidanceOptions): string {
  if (!options.command.trim() || /[\0\r\n]/.test(options.command)
    || (options.stateDirectory !== undefined && /[\0\r\n]/.test(options.stateDirectory))
    || (options.minSavingsTokens !== undefined && (!Number.isSafeInteger(options.minSavingsTokens) || options.minSavingsTokens < 0))
    || (options.scope !== undefined && !/^[a-f0-9]{64}$/.test(options.scope))) {
    throw new Error('Unsupported CLI recovery path');
  }
  const rule = `Fold long evidence, keeping conclusions, constraints, failures and next steps outside. Closed markers fold directly without a savings threshold. Never wrap progress or tool-only work: tools are not folded. No empty blocks, logs or filler. Use whole-line delimiters, no Markdown prefixes or split > >. Keep evidence open across related tool calls until verified; never close short preambles or reopen per call. Skip short/exact-format answers; never expose private reasoning. Markers prove no saving. Read actual path only when needed. Arrow keep blocks are literal. Example (shortened):
→ 不折叠开始
Finding: retry charges twice.
>> Evidence for duplicate charging <<
The first debit commits. Retry repeats it with the same ID and no completion check.
→ 不折叠开始
Keep: request_id=42; test pending.
← 不折叠结束
Both debits appear in the ledger.
<< Same request debited twice >>
Next: deduplicate and test.
← 不折叠结束`;
  const archiveDirectory = options.stateDirectory ? ` --dir ${shellQuote(resolve(options.stateDirectory, 'archive'))}` : '';
  const recall = options.scope
    ? ` Need source: read the actual path; or ${options.command} search${archiveDirectory} 'TEXT'; ${options.command} read${archiveDirectory} HASH.` : '';
  return `<context-folding>${rule}${recall}</context-folding>`;
}

function appendToCleanBody(result: Body, protocol: Protocol, options: GuidanceOptions): Body {
  const text = guidanceText(options);
  if (protocol === 'chat') {
    if (!Array.isArray(result.messages)) throw new Error('Unsupported chat instructions');
    let index = 0;
    while (index < result.messages.length && record(result.messages[index])
      && ['system', 'developer'].includes(String((result.messages[index] as Body).role))) index++;
    const role = result.messages.slice(0, index).some(item => record(item) && item.role === 'developer') ? 'developer' : 'system';
    result.messages.splice(index, 0, { role, content: text });
  } else if (protocol === 'responses') {
    if (result.instructions !== undefined && typeof result.instructions !== 'string') throw new Error('Unsupported response instructions');
    result.instructions = result.instructions ? `${result.instructions}\n\n${text}` : text;
  } else if (protocol === 'anthropic') {
    if (typeof result.system === 'string') result.system = result.system ? `${result.system}\n\n${text}` : text;
    else if (result.system === undefined || Array.isArray(result.system)) result.system = [...(result.system ?? []) as unknown[], { type: 'text', text }];
    else throw new Error('Unsupported Anthropic instructions');
  } else {
    const holders = [result, ...(record(result.config) ? [result.config] : [])];
    const existing = holders.flatMap(holder => ['systemInstruction', 'system_instruction']
      .filter(key => Object.hasOwn(holder, key)).map(key => ({ holder, key })));
    if (existing.length > 1) throw new Error('Ambiguous Gemini instruction fields');
    const { holder, key } = existing[0] ?? { holder: record(result.config) ? result.config : result, key: 'systemInstruction' };
    const previous = holder[key];
    if (typeof previous === 'string') holder[key] = previous ? `${previous}\n\n${text}` : text;
    else if (previous === undefined || (record(previous) && Array.isArray(previous.parts))) {
      holder[key] = { ...(record(previous) ? previous : {}), parts: [...(record(previous) ? previous.parts as unknown[] : []), { text }] };
    } else throw new Error('Unsupported Gemini instructions');
  }
  return result;
}

/** Add guidance to a body already stripped of prior plugin guidance. */
export function appendGuidanceToCleanBody(body: Body, protocol: Protocol, options: GuidanceOptions): Body {
  const result = { ...body };
  if (protocol === 'chat' && Array.isArray(body.messages)) result.messages = [...body.messages];
  if (protocol === 'gemini' && record(body.config)) result.config = { ...body.config };
  return appendToCleanBody(result, protocol, options);
}

/** Inject once in the protocol's real system field, preserving the host prefix. */
export function appendGuidance(body: Body, protocol: Protocol, options: GuidanceOptions): Body {
  return appendToCleanBody(withoutGuidance(body, protocol), protocol, options);
}
