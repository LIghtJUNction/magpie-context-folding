import type { Protocol } from './protocol.js';

type Body = Record<string, unknown>;
const record = (value: unknown): value is Body => !!value && typeof value === 'object' && !Array.isArray(value);
const recoveryMetadata = /^<context-folding scope=[a-f0-9]{64}\s*\/>$/;
// Upgrade cleanup only: recognize the retired plugin metadata without computing
// or retaining any of its capacity, reserve, or usage values.
const legacyMetadata = /^<context-budget used_estimate=\d+ capacity=(?:\d+|unknown) output_reserved=\d+ available_estimate=(?:\d+|unknown) basis=json-utf8-bytes\/4(?: scope=[a-f0-9]{64})?\s*\/>$/;
const isMetadata = (value: string): boolean => recoveryMetadata.test(value) || legacyMetadata.test(value);

function stripMetadataText(text: string): string {
  // Hosts may join text blocks or append instructions after our metadata.
  return text.split('\n\n').filter(part => !isMetadata(part))
    .map(part => part.split('\n').filter(line => !isMetadata(line)).join('\n')).join('\n\n');
}

function cleanTextParts(parts: unknown[]): unknown[] {
  return parts.flatMap(part => {
    if (!record(part) || typeof part.text !== 'string') return [part];
    const text = stripMetadataText(part.text);
    if (text === part.text) return [part];
    return text ? [{ ...part, text }] : [];
  });
}

/** Remove only plugin system metadata; conversation text is never interpreted. */
export function withoutRecoveryMetadata(body: Body, protocol: Protocol): Body {
  const result = structuredClone(body);
  if (protocol === 'chat' && Array.isArray(result.messages)) {
    result.messages = result.messages.flatMap(item => {
      if (!record(item) || item.role !== 'system') return [item];
      if (typeof item.content === 'string') {
        const content = stripMetadataText(item.content);
        if (content === item.content) return [item];
        return content ? [{ ...item, content }] : [];
      }
      if (Array.isArray(item.content)) {
        const content = cleanTextParts(item.content);
        return content.length || !item.content.length ? [{ ...item, content }] : [];
      }
      return [item];
    });
  } else if (protocol === 'responses' && typeof result.instructions === 'string') {
    const instructions = stripMetadataText(result.instructions);
    if (instructions || instructions === result.instructions) result.instructions = instructions;
    else delete result.instructions;
  } else if (protocol === 'anthropic') {
    if (Array.isArray(result.system)) {
      const system = cleanTextParts(result.system);
      if (system.length || !result.system.length) result.system = system;
      else delete result.system;
    } else if (typeof result.system === 'string') {
      result.system = stripMetadataText(result.system);
    }
  } else if (protocol === 'gemini') {
    const holder = record(result.config) ? result.config : result;
    for (const key of ['systemInstruction', 'system_instruction']) {
      const instruction = holder[key];
      if (record(instruction) && Array.isArray(instruction.parts)) {
        const parts = cleanTextParts(instruction.parts);
        if (parts.length || !instruction.parts.length || Object.keys(instruction).some(key => key !== 'parts')) instruction.parts = parts;
        else delete holder[key];
      }
    }
  }
  return result;
}

/** Supply only the capability needed to recover archived text. */
export function appendRecoveryMetadata(body: Body, protocol: Protocol, scope: string): Body {
  if (!/^[a-f0-9]{64}$/.test(scope)) throw new Error('Invalid recovery scope');
  const result = withoutRecoveryMetadata(body, protocol);
  const text = `<context-folding scope=${scope} />`;
  if (protocol === 'chat') {
    if (!Array.isArray(result.messages)) throw new Error('Unsupported recovery metadata container');
    result.messages.unshift({ role: 'system', content: text });
  } else if (protocol === 'responses') {
    if (result.instructions !== undefined && typeof result.instructions !== 'string') throw new Error('Unsupported recovery metadata container');
    result.instructions = result.instructions ? `${result.instructions}\n\n${text}` : text;
  } else if (protocol === 'anthropic') {
    if (result.system !== undefined && typeof result.system !== 'string' && !Array.isArray(result.system)) throw new Error('Unsupported recovery metadata container');
    if (typeof result.system === 'string') result.system = result.system ? `${result.system}\n\n${text}` : text;
    else result.system = [...(result.system ?? []) as unknown[], { type: 'text', text }];
  } else {
    const holder = record(result.config) ? result.config : result;
    const key = Object.hasOwn(holder, 'system_instruction') ? 'system_instruction' : 'systemInstruction';
    const previous = holder[key];
    if (previous !== undefined && (!record(previous) || !Array.isArray(previous.parts))) throw new Error('Unsupported recovery metadata container');
    holder[key] = { ...(record(previous) ? previous : {}), parts: [...(record(previous) ? previous.parts as unknown[] : []), { text }] };
  }
  return result;
}
