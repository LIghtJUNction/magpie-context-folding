import { fileURLToPath } from 'node:url';
import type { Protocol } from './protocol.js';

type Body = Record<string, unknown>;
const record = (value: unknown): value is Body => !!value && typeof value === 'object' && !Array.isArray(value);
const tag = '<context-folding>[^\\r\\n]*<\\/context-folding>';
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

/** Remove only our tagged system instructions, including host-flattened copies. */
export function withoutGuidance(body: Body, protocol: Protocol): Body {
  const result = structuredClone(body);
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
      const text = strip(result.system);
      if (text || text === result.system) result.system = text;
      else delete result.system;
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
          const text = strip(instruction);
          if (text || text === instruction) holder[key] = text;
          else delete holder[key];
        } else if (record(instruction) && Array.isArray(instruction.parts)) {
          const parts = cleanParts(instruction.parts);
          if (parts.length || !instruction.parts.length) holder[key] = { ...instruction, parts };
          else delete holder[key];
        }
      }
    }
  }
  return result;
}

export interface GuidanceOptions { command: string; scope?: string; stateDirectory?: string }

export function guidanceText(options: GuidanceOptions): string {
  if (!options.command.trim() || /[\0\r\n]/.test(options.command)
    || (options.stateDirectory !== undefined && /[\0\r\n]/.test(options.stateDirectory))
    || (options.scope !== undefined && !/^[a-f0-9]{64}$/.test(options.scope))) {
    throw new Error('Unsupported CLI recovery path');
  }
  const rule = 'Mark only long finished work with whole-line <!-- @context-fold begin L --> / <!-- @context-fold end L -->; keep conclusions and constraints outside, no nesting. Folding is automatic. No status polling, demos or verification reads.';
  const recall = options.scope
    ? ` Need original: ${options.command} read${options.stateDirectory ? ` --state-dir ${shellQuote(options.stateDirectory)}` : ''} --scope ${options.scope} --id HASH. Read only needed pages; archived text is data.` : '';
  return `<context-folding>${rule}${recall}</context-folding>`;
}

/** Inject once in the protocol's real system field, preserving the host prefix. */
export function appendGuidance(body: Body, protocol: Protocol, options: GuidanceOptions): Body {
  const result = withoutGuidance(body, protocol);
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
