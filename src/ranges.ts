import { createHash } from 'node:crypto';
import type { Protocol } from './protocol.js';

type Body = Record<string, unknown>;
const record = (value: unknown): value is Body => !!value && typeof value === 'object' && !Array.isArray(value);
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const points = (text: string) => Array.from(text);

/** A missing offset means the boundary BEFORE this zero-based message index. */
export interface ConversationPosition { message: number; offset?: number }
/** Half-open range. Offsets count Unicode code points, not UTF-16 code units. */
export interface ConversationRange { start: ConversationPosition; end: ConversationPosition }
interface Position { message: number; offset: number }
interface NormalRange { start: Position; end: Position }

export class RangeSelectionError extends Error {
  constructor(public readonly code: string, message: string, public readonly suggestedRange?: ConversationRange) {
    super(message);
    this.name = 'RangeSelectionError';
  }
}

export interface ConversationSelection {
  protocol: Protocol;
  range: ConversationRange;
  /** Canonical recovery source: header plus COMPLETE original boundary messages. */
  transcript: string;
  /** Searchable display of the selected fragments, with role/range provenance. */
  text: string;
  /** Hash of transcript, so equal words from different roles never alias. */
  sha256: string;
  /** Stable across index shifts and cuts to unselected prefix/suffix text. */
  contentIdentity: string;
}

interface History { key: 'messages' | 'input' | 'contents'; messages: unknown[] }
function history(body: Body, protocol: Protocol): History {
  if (protocol === 'responses' && (body.previous_response_id != null || body.conversation != null)) {
    throw new RangeSelectionError('hidden-history', 'A complete, editable history is required; server-managed history cannot be folded');
  }
  const key = protocol === 'responses' ? 'input' : protocol === 'gemini' ? 'contents' : 'messages';
  const value = body[key];
  if (protocol === 'responses' && typeof value === 'string') return { key, messages: [{ role: 'user', content: value }] };
  if (!Array.isArray(value)) throw new RangeSelectionError('invalid-history', `Expected a ${key} array`);
  return { key, messages: value };
}

function roleOf(message: Body, protocol: Protocol): string {
  if (protocol === 'responses' && ['function_call', 'custom_tool_call'].includes(String(message.type))) return 'assistant';
  if (protocol === 'responses' && ['function_call_output', 'custom_tool_call_output'].includes(String(message.type))) return 'tool';
  if (protocol === 'gemini' && message.role === 'model') return 'assistant';
  return typeof message.role === 'string' ? message.role : 'unknown';
}

const protectedFields = ['signature', 'thoughtSignature', 'thought_signature', 'encrypted_content', 'encryptedContent'];
function protectedObject(value: Body): boolean {
  return protectedFields.some(key => key in value) || value.thought === true
    || ['thinking', 'redacted_thinking', 'reasoning', 'compaction'].includes(String(value.type));
}

function textPart(part: unknown, protocol: Protocol): part is Body & { text: string } {
  if (!record(part) || typeof part.text !== 'string' || protectedObject(part)) return false;
  if (protocol === 'gemini') return !('functionCall' in part) && !('functionResponse' in part)
    && !('inlineData' in part) && !('fileData' in part) && !('inline_data' in part) && !('file_data' in part);
  return (protocol === 'responses' ? ['text', 'input_text', 'output_text'] : ['text']).includes(String(part.type));
}

/** Text offsets are available only for a message whose body consists of text. */
function messageText(message: unknown, protocol: Protocol, allowCalls = false): string | undefined {
  if (!record(message) || protectedObject(message) || !['user', 'assistant'].includes(roleOf(message, protocol))) return;
  if (protocol === 'responses' && message.type !== undefined && message.type !== 'message') return;
  if (!allowCalls && (Array.isArray(message.tool_calls) && message.tool_calls.length > 0 || message.function_call != null)) return;
  const content = message[protocol === 'gemini' ? 'parts' : 'content'];
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && content.every(part => textPart(part, protocol))) return content.map(part => (part as Body).text).join('');
}

function safeTextContent(content: unknown, protocol: Protocol): boolean {
  return content == null || typeof content === 'string'
    || Array.isArray(content) && content.every(part => textPart(part, protocol));
}

/** Never hide an instruction role, opaque reasoning, attachment, or unknown wire item. */
function assertFoldable(message: unknown, protocol: Protocol, index: number): asserts message is Body {
  const reject = () => { throw new RangeSelectionError('protected-message', `Message ${index} contains protected or unsupported content`); };
  if (!record(message) || protectedObject(message)) return reject();
  const role = roleOf(message, protocol);
  if (!['user', 'assistant', 'tool'].includes(role)) return reject();
  if (protocol === 'chat') {
    if (message.function_call != null || !safeTextContent(message.content, protocol)) return reject();
    if (role === 'tool' && (typeof message.tool_call_id !== 'string' || !message.tool_call_id)) return reject();
    if (message.tool_calls !== undefined && (!Array.isArray(message.tool_calls)
      || message.tool_calls.some(call => !record(call) || typeof call.id !== 'string' || !call.id))) return reject();
  } else if (protocol === 'responses') {
    if (['function_call', 'custom_tool_call'].includes(String(message.type))) {
      if (typeof message.call_id !== 'string' || !message.call_id) return reject();
    } else if (['function_call_output', 'custom_tool_call_output'].includes(String(message.type))) {
      if (typeof message.call_id !== 'string' || !message.call_id || !safeTextContent(message.output, protocol)) return reject();
    } else if ((message.type !== undefined && message.type !== 'message') || !safeTextContent(message.content, protocol)) return reject();
  } else if (protocol === 'anthropic') {
    if (typeof message.content === 'string') return;
    if (!Array.isArray(message.content) || message.content.some(part => {
      if (textPart(part, protocol)) return false;
      if (!record(part) || protectedObject(part)) return true;
      if (part.type === 'tool_use') return typeof part.id !== 'string' || !part.id;
      if (part.type === 'tool_result') return typeof part.tool_use_id !== 'string' || !part.tool_use_id || !safeTextContent(part.content, protocol);
      return true;
    })) return reject();
  } else if (!Array.isArray(message.parts) || message.parts.some(part => {
    if (textPart(part, protocol)) return false;
    if (!record(part) || protectedObject(part)) return true;
    const operation = part.functionCall ?? part.functionResponse;
    return !record(operation) || typeof operation.name !== 'string' || !operation.name;
  })) return reject();
}

function compare(a: Position, b: Position): number { return a.message - b.message || a.offset - b.offset; }

function normalizePosition(value: ConversationPosition, messages: unknown[], protocol: Protocol): Position {
  if (!record(value) || !Number.isSafeInteger(value.message) || value.message < 0 || value.message > messages.length
    || value.offset !== undefined && (!Number.isSafeInteger(value.offset) || value.offset < 0)) {
    throw new RangeSelectionError('invalid-position', 'Positions require a valid zero-based message index and a nonnegative code-point offset');
  }
  const offset = value.offset ?? 0;
  if (offset === 0) return { message: value.message, offset: 0 };
  if (value.message === messages.length) throw new RangeSelectionError('invalid-position', 'The end-of-history boundary has no text offset');
  const text = messageText(messages[value.message], protocol);
  if (text === undefined) throw new RangeSelectionError('atomic-message', `Message ${value.message} must be selected as a whole; only pure text messages support offsets`);
  const length = points(text).length;
  if (offset > length) throw new RangeSelectionError('invalid-position', `Offset exceeds the ${length} code points in message ${value.message}`);
  if (offset === length) return { message: value.message + 1, offset: 0 };
  return { message: value.message, offset };
}

function normalize(range: ConversationRange, messages: unknown[], protocol: Protocol): NormalRange {
  if (!record(range)) throw new RangeSelectionError('invalid-range', 'Expected start and end positions');
  const start = normalizePosition(range.start, messages, protocol);
  const end = normalizePosition(range.end, messages, protocol);
  if (compare(start, end) >= 0) throw new RangeSelectionError('invalid-range', 'The selected range must be nonempty and ordered');
  return { start, end };
}

interface Fragment { message: number; from: number; to: number | null; original: Body; value: Body; partial: boolean }
function sliceMessage(message: Body, protocol: Protocol, from: number, to: number): Body {
  const key = protocol === 'gemini' ? 'parts' : 'content';
  const content = message[key];
  const result = structuredClone(message);
  if (typeof content === 'string') result[key] = points(content).slice(from, to).join('');
  else if (Array.isArray(content)) {
    let offset = 0;
    const parts: Body[] = [];
    for (const value of content) {
      if (!textPart(value, protocol)) throw new RangeSelectionError('atomic-message', 'Non-text parts cannot be split');
      const text = points(value.text);
      const begin = Math.max(0, from - offset);
      const end = Math.min(text.length, to - offset);
      if (begin < end) {
        // Citation/source coordinates are relative to the original text. Do not
        // carry stale offsets into a partial block or silently discard metadata.
        if ((begin > 0 || end < text.length) && (Array.isArray(value.annotations) && value.annotations.length > 0
          || Array.isArray(value.citations) && value.citations.length > 0)) {
          throw new RangeSelectionError('annotated-text', 'Text with coordinate-bearing annotations must be kept as a whole block');
        }
        parts.push({ ...structuredClone(value), text: text.slice(begin, end).join('') });
      }
      offset += text.length;
    }
    result[key] = parts;
  }
  return result;
}

function fragments(messages: unknown[], protocol: Protocol, range: NormalRange, validate: boolean): Fragment[] {
  const result: Fragment[] = [];
  const last = range.end.offset === 0 ? range.end.message - 1 : range.end.message;
  for (let index = range.start.message; index <= last; index++) {
    const original = messages[index];
    if (validate) assertFoldable(original, protocol, index);
    else if (!record(original)) throw new RangeSelectionError('invalid-history', `Message ${index} is not an object`);
    const from = index === range.start.message ? range.start.offset : 0;
    const to = index === range.end.message ? range.end.offset : null;
    const partial = from > 0 || to !== null;
    if (!partial) result.push({ message: index, from, to, original, value: structuredClone(original), partial });
    else {
      const text = messageText(original, protocol);
      if (text === undefined) throw new RangeSelectionError('atomic-message', `Message ${index} must be selected as a whole`);
      const end = to ?? points(text).length;
      if (from < end) result.push({ message: index, from, to: end, original, value: sliceMessage(original, protocol, from, end), partial });
    }
  }
  return result;
}

interface Exchange { calls: number[]; results: number[] }
function exchanges(messages: unknown[], protocol: Protocol): Exchange[] {
  const groups = new Map<string, Exchange>();
  const add = (id: unknown, kind: 'calls' | 'results', index: number) => {
    if (typeof id !== 'string' || !id) return;
    const group = groups.get(id) ?? { calls: [], results: [] };
    group[kind].push(index);
    groups.set(id, group);
  };
  messages.forEach((value, index) => {
    if (!record(value)) return;
    if (protocol === 'chat') {
      if (Array.isArray(value.tool_calls)) for (const call of value.tool_calls) if (record(call)) add(call.id, 'calls', index);
      if (value.role === 'tool') add(value.tool_call_id, 'results', index);
    } else if (protocol === 'responses') {
      if (['function_call', 'custom_tool_call'].includes(String(value.type))) add(value.call_id, 'calls', index);
      if (['function_call_output', 'custom_tool_call_output'].includes(String(value.type))) add(value.call_id, 'results', index);
    } else {
      const parts = protocol === 'gemini' ? value.parts : value.content;
      if (!Array.isArray(parts)) return;
      for (const part of parts) {
        if (!record(part)) continue;
        if (protocol === 'anthropic') {
          if (part.type === 'tool_use') add(part.id, 'calls', index);
          if (part.type === 'tool_result') add(part.tool_use_id, 'results', index);
        } else {
          // Name-only Gemini calls form one atomic group. This is deliberately
          // conservative for parallel calls with the same name and no IDs.
          for (const [key, kind] of [['functionCall', 'calls'], ['functionResponse', 'results']] as const) {
            const operation = part[key];
            if (record(operation)) add(typeof operation.id === 'string' ? `id:${operation.id}` : `name:${String(operation.name)}`, kind, index);
          }
        }
      }
    }
  });
  return [...groups.values()];
}

function assertToolClosure(messages: unknown[], protocol: Protocol, range: NormalRange, selected: Fragment[]): void {
  const complete = new Set(selected.filter(fragment => !fragment.partial).map(fragment => fragment.message));
  for (const exchange of exchanges(messages, protocol)) {
    const indexes = [...exchange.calls, ...exchange.results];
    const removed = indexes.filter(index => complete.has(index));
    const first = Math.min(...indexes);
    const last = Math.max(...indexes);
    const insideExchange = exchange.calls.length > 0 && exchange.results.length > 0
      && compare(range.start, { message: first, offset: 0 }) > 0
      && compare(range.start, { message: last + 1, offset: 0 }) < 0;
    const afterPendingCall = exchange.calls.length > exchange.results.length
      && compare(range.start, { message: Math.min(...exchange.calls), offset: 0 }) > 0;
    if (removed.length > 0 && (removed.length !== indexes.length || exchange.calls.length !== exchange.results.length)
      || removed.length === 0 && (insideExchange || afterPendingCall)) {
      throw new RangeSelectionError('tool-boundary', 'The range splits a tool exchange; select the complete call/result group or keep it outside the range',
        { start: { message: first }, end: { message: last + 1 } });
    }
  }
}

function readable(message: Body, protocol: Protocol): string {
  const key = protocol === 'gemini' ? 'parts' : 'content';
  const content = message[key] ?? message.output;
  const blocks: string[] = [];
  if (typeof content === 'string') blocks.push(content);
  else if (Array.isArray(content)) for (const part of content) {
    blocks.push(textPart(part, protocol) ? part.text : JSON.stringify(part, null, 2));
  }
  if (message.tool_calls !== undefined) blocks.push(JSON.stringify({ tool_calls: message.tool_calls }, null, 2));
  if (['function_call', 'custom_tool_call'].includes(String(message.type))) blocks.push(JSON.stringify(message, null, 2));
  return blocks.join('\n');
}

/**
 * Select before any mutation. The transcript retains complete boundary objects,
 * including their original roles and metadata; the display contains only the
 * requested fragments. A partial text cut never splits a surrogate pair.
 */
export function selectConversationRange(body: Body, protocol: Protocol, range: ConversationRange): ConversationSelection {
  const { messages } = history(body, protocol);
  const normalized = normalize(range, messages, protocol);
  const selected = fragments(messages, protocol, normalized, true);
  assertToolClosure(messages, protocol, normalized, selected);
  // Check BOTH retained sides now, before the caller durably archives a range.
  // This catches coordinate-bearing annotation blocks split by either boundary.
  if (normalized.start.offset > 0) {
    sliceMessage(messages[normalized.start.message] as Body, protocol, 0, normalized.start.offset);
  }
  if (normalized.end.offset > 0) {
    const ending = messages[normalized.end.message] as Body;
    sliceMessage(ending, protocol, normalized.end.offset, points(messageText(ending, protocol)!).length);
  }
  const transcript = [JSON.stringify({ format: 'context-folding/conversation-v1', protocol, range: normalized, offsetUnit: 'unicode-code-point' }),
    ...selected.map(fragment => JSON.stringify({ message: fragment.message,
      selected: { start: fragment.from, end: fragment.to }, original: fragment.original }))].join('\n') + '\n';
  if (Buffer.from(transcript, 'utf8').toString('utf8') !== transcript) throw new RangeSelectionError('invalid-unicode', 'Conversation contains invalid Unicode');
  const text = [`Archived conversation (${protocol}); offsets are Unicode code points; end is exclusive.`,
    ...selected.map(fragment => `\n--- message ${fragment.message} | role ${roleOf(fragment.original, protocol)} | selected ${fragment.from}:${fragment.to ?? 'end'} ---\n${readable(fragment.value, protocol)}`)].join('\n');
  if (Buffer.from(text, 'utf8').toString('utf8') !== text) throw new RangeSelectionError('invalid-unicode', 'Selected text contains invalid Unicode');
  const contentIdentity = hash(JSON.stringify(selected.map((fragment, index) => {
    const value = structuredClone(fragment.value);
    // A split Responses fragment may lose its optional wire ID. The contents,
    // roles, tool IDs and content-block metadata still identify the selection.
    delete value.id;
    delete value.status;
    if (index === selected.length - 1) {
      // Appending another block to a message can add a physical newline after a
      // previously final end marker. It is outside the completed work and must
      // not restart that block's observation period. Only the lifecycle identity
      // is normalized; transcript and searchable text retain every character.
      const text = messageText(value, protocol, true);
      const ending = text === undefined ? null : /(?:\r\n|\r|\n)$/.exec(text);
      if (text !== undefined && ending) {
        const withoutEnding = text.slice(0, -ending[0].length);
        const directive = marker(withoutEnding.split(/\r\n|\r|\n/).at(-1) ?? '');
        if (directive && directive !== 'invalid' && directive.kind === 'end') {
          const contentKey = protocol === 'gemini' ? 'parts' : 'content';
          const content = value[contentKey];
          if (typeof content === 'string') value[contentKey] = withoutEnding;
          else if (Array.isArray(content)) {
            let remaining = ending[0].length;
            for (let partIndex = content.length - 1; partIndex >= 0 && remaining > 0; partIndex--) {
              const part = content[partIndex];
              if (!textPart(part, protocol)) break;
              const remove = Math.min(remaining, part.text.length);
              part.text = part.text.slice(0, part.text.length - remove);
              remaining -= remove;
            }
          }
        }
      }
    }
    return value;
  })));
  return { protocol, range: normalized, transcript, text, sha256: hash(transcript), contentIdentity };
}

function referenceMessage(protocol: Protocol, text: string): Body {
  if (protocol === 'gemini') return { role: 'user', parts: [{ text }] };
  if (protocol === 'responses') return { role: 'user', content: [{ type: 'input_text', text }] };
  return { role: 'user', content: text };
}

/** Project multiple disjoint selections against the SAME original request. */
export function projectConversationRanges(body: Body, protocol: Protocol,
  replacements: readonly { selection: ConversationSelection; referenceText: string }[]): Body {
  const { key, messages } = history(body, protocol);
  const edits = replacements.map(edit => {
    if (edit.selection.protocol !== protocol || !edit.referenceText) throw new RangeSelectionError('invalid-projection', 'Projection protocol and nonempty reference are required');
    const fresh = selectConversationRange(body, protocol, edit.selection.range);
    if (fresh.transcript !== edit.selection.transcript) throw new RangeSelectionError('stale-selection', 'The selected history changed before projection');
    return { ...edit, range: normalize(edit.selection.range, messages, protocol) };
  }).sort((a, b) => compare(a.range.start, b.range.start));
  if (!edits.length) return structuredClone(body);
  const output: Body[] = [];
  const emitted = new Set<number>();
  const keep = (start: Position, end: Position) => {
    if (compare(start, end) >= 0) return;
    for (const fragment of fragments(messages, protocol, { start, end }, false)) {
      // Splitting one Responses message creates derived fragments. An optional
      // wire ID may be retained only once; complete original metadata is in JSONL.
      if (emitted.has(fragment.message) && protocol === 'responses') delete fragment.value.id;
      emitted.add(fragment.message);
      output.push(fragment.value);
    }
  };
  let cursor: Position = { message: 0, offset: 0 };
  for (const edit of edits) {
    if (compare(cursor, edit.range.start) > 0) throw new RangeSelectionError('overlapping-ranges', 'Conversation ranges must be disjoint');
    keep(cursor, edit.range.start);
    output.push(referenceMessage(protocol, edit.referenceText));
    cursor = edit.range.end;
  }
  keep(cursor, { message: messages.length, offset: 0 });
  return { ...structuredClone(body), [key]: output };
}

export function projectConversationRange(body: Body, protocol: Protocol, selection: ConversationSelection, referenceText: string): Body {
  return projectConversationRanges(body, protocol, [{ selection, referenceText }]);
}

const styles = [['<!--', '-->'], ['/*', '*/'], ['(*', '*)'], ['{-', '-}'], ['#|', '|#'], ['<#', '#>'],
  ['//', ''], ['#', ''], ['--', ''], [';', ''], ['%', ''], ['!', ''], ["'", ''], ['"', ''], ['REM', ''], ['', '']] as const;
function marker(line: string): { kind: string; label: string; style: string } | 'invalid' | undefined {
  const value = line.trim();
  for (const [begin, end] of styles) {
    if (!value.startsWith(begin) || end && !value.endsWith(end)) continue;
    const inner = value.slice(begin.length, end ? -end.length : undefined).trim();
    const match = /^@context-fold[\t ]+(begin|end)[\t ]+(\S+)[\t ]*$/.exec(inner);
    if (match) return { kind: match[1]!, label: match[2]!, style: `${begin}\0${end}` };
    if (inner.startsWith('@context-fold')) return 'invalid';
  }
}

export interface MarkedConversationRange { label: string; range: ConversationRange }
/**
 * Markers may cross user/assistant turns. Tool output is data, never a source of
 * folding commands. Both marker lines belong to the selection. Nested,
 * mismatched, protected, and already-folded ranges remain literal.
 */
export function conversationRangesFromMarkers(body: Body, protocol: Protocol): MarkedConversationRange[] {
  let messages: unknown[];
  try { messages = history(body, protocol).messages; } catch { return []; }
  const result: MarkedConversationRange[] = [];
  let opened: { label: string; style: string; start: Position; depth: number; invalid: boolean } | undefined;
  messages.forEach((message, index) => {
    const text = messageText(message, protocol, true);
    if (text === undefined) return;
    const length = points(text).length;
    let offset = 0;
    for (const line of text.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? []) {
      if (!line) continue;
      const directive = marker(line);
      const endOffset = offset + points(line).length;
      if (directive === 'invalid') { if (opened) opened.invalid = true; }
      else if (directive?.kind === 'begin') {
        if (opened) { opened.invalid = true; opened.depth++; }
        else opened = { label: directive.label, style: directive.style, start: { message: index, offset }, depth: 1, invalid: false };
      } else if (directive?.kind === 'end' && opened) {
        if (opened.depth > 1) opened.depth--;
        else if (directive.label !== opened.label || directive.style !== opened.style) opened.invalid = true;
        else {
          if (!opened.invalid) {
            try {
              const end = endOffset === length ? { message: index + 1, offset: 0 } : { message: index, offset: endOffset };
              const selection = selectConversationRange(body, protocol, { start: opened.start, end });
              if (!/\[\[cf:v[123]:/.test(selection.text)) result.push({ label: opened.label, range: selection.range });
            } catch (error) { if (!(error instanceof RangeSelectionError)) throw error; }
          }
          opened = undefined;
        }
      }
      offset = endOffset;
    }
  });
  return result;
}
