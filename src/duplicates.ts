import type { Entry } from './store.js';
import type { Span } from './protocol.js';

const prefix = (id: string) => `[context-folding duplicate id=${id} role=tool]`;
export const isDuplicateFold = (entry: Entry): boolean => entry.folded?.startsWith(prefix(entry.id) + '\n') ?? false;

/** Replay the accepted alias while its original inline reference remains valid. */
export function canReplayDuplicate(entry: Entry, spans: readonly Span[], entries: ReadonlyMap<string, Entry>, eligible: ReadonlySet<string>): boolean {
  if (!isDuplicateFold(entry)) return false;
  const marker = '\nExact repeat of JSON path ';
  // The generated reference follows the summary; Opening is JSON-escaped and
  // cannot contain this literal newline marker, even when original text does.
  const position = entry.folded!.lastIndexOf(marker);
  if (position < 0) return false;
  const reference = entry.folded!.slice(position + marker.length).split('\n', 1)[0]!;
  const suffix = ' (zero-based); full text stays inline. Same text, separate observation.';
  const end = reference.indexOf(suffix);
  if (end < 0) return false;
  let path: unknown;
  try { path = JSON.parse(reference.slice(0, end)); } catch { return false; }
  const current = spans.find(span => span.id === entry.id);
  if (!current || current.role !== 'tool' || current.text !== entry.text || current.protectedReason !== undefined) return false;
  return spans.some(anchor => anchor.id !== entry.id && anchor.role === 'tool'
    && !eligible.has(anchor.id) && anchor.protectedReason === undefined
    && anchor.text === entry.text && entries.get(anchor.id)?.text === anchor.text
    && JSON.stringify(anchor.path) === JSON.stringify(path)
    && JSON.stringify(anchor.source ?? null) === JSON.stringify(current.source ?? null));
}

/** Keep one protected inline copy; replace only byte-identical, eligible tool text. */
export function duplicatePlans(spans: readonly Span[], entries: ReadonlyMap<string, Entry>, eligible: ReadonlySet<string>, headChars: number): Map<string, string> {
  const anchors = new Map<string, Map<string, Span>>();
  const source = (span: Span) => JSON.stringify(span.source ?? null);
  for (const span of spans) {
    if (span.role !== 'tool' || eligible.has(span.id) || span.protectedReason !== undefined) continue;
    const entry = entries.get(span.id);
    if (!entry || entry.text !== span.text) continue;
    const bySource = anchors.get(span.text) ?? new Map<string, Span>();
    bySource.set(source(span), span);
    anchors.set(span.text, bySource);
  }
  const plans = new Map<string, string>();
  for (const span of spans) {
    if (span.role !== 'tool' || !eligible.has(span.id) || span.protectedReason !== undefined) continue;
    const entry = entries.get(span.id);
    if (!entry || entry.text !== span.text || entry.mark.disposition === 'keep'
      || (entry.manual && entry.mark.disposition === 'unmarked')) continue;
    const anchor = anchors.get(span.text)?.get(source(span));
    if (!anchor || anchor.id === span.id) continue;
    const summary = entry.mark.disposition === 'foldable'
      ? `\nSummary (${entry.version?.automatic || entry.manual === false ? 'automatic policy' : 'agent-written'}): ${entry.mark.summary}` : '';
    let end = Math.min(headChars, entry.text.length);
    if (end > 0 && /[\uD800-\uDBFF]/.test(entry.text[end - 1]!) && /[\uDC00-\uDFFF]/.test(entry.text[end] ?? '')) end--;
    const text = `${prefix(entry.id)}${summary}\nExact repeat of JSON path ${JSON.stringify(anchor.path)} (zero-based); full text stays inline. Same text, separate observation. Original UTF-16: inline [0,${end}); archived [0,${entry.text.length})\nOpening: ${JSON.stringify(entry.text.slice(0, end))}`;
    if (Buffer.byteLength(JSON.stringify(text)) < Buffer.byteLength(JSON.stringify(span.text))) plans.set(span.id, text);
  }
  return plans;
}
