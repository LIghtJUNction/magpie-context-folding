import type { Entry } from './store.js';

// Deliberately accept only this complete, two-line UI status block. New results,
// failures, extra annotations and other agents are boundaries, never discarded.
const block = /^没有新的测试结果。\n\n● Agent ("[^"\r\n\u0000-\u001f\u2028\u2029]{1,128}"|[A-Za-z0-9][A-Za-z0-9_.-]{0,127}) is waiting on its own background work · ((?:\d+h )?(?:\d+m )?\d+s)$/gm;

function seconds(time: string): number {
  const parts = /^(?:(\d+)h )?(?:(\d+)m )?(\d+)s$/.exec(time)!;
  return Number(parts[1] ?? 0) * 3600 + Number(parts[2] ?? 0) * 60 + Number(parts[3]);
}

/** Compact consecutive observations inside one already-authorized history span. */
export function pollingRepresentation(entry: Entry): string | undefined {
  if (entry.mark.disposition !== 'foldable' || (entry.role === 'user' && !entry.manual)) return undefined;
  const matches = [...entry.text.matchAll(block)];
  let result = '', cursor = 0, compacted = false;
  for (let first = 0; first < matches.length;) {
    let last = first;
    while (last + 1 < matches.length) {
      const current = matches[last]!, next = matches[last + 1]!;
      const before = seconds(current[2]!), after = seconds(next[2]!);
      if (entry.text.slice(current.index! + current[0].length, next.index) !== '\n\n'
        || next[1] !== current[1] || !Number.isSafeInteger(before) || !Number.isSafeInteger(after)
        || after < before) break;
      last++;
    }
    if (last > first) {
      const start = matches[first]!, end = matches[last]!;
      result += entry.text.slice(cursor, start.index);
      result += `[polling observations: count=${last - first + 1}; Agent ${start[1]}; first elapsed=${start[2]}; last elapsed=${end[2]}; elapsed readings may differ]\n没有新的测试结果。\n● Agent ${start[1]} is waiting on its own background work`;
      cursor = end.index! + end[0].length;
      compacted = true;
    }
    first = last + 1;
  }
  if (!compacted) return undefined;
  result += entry.text.slice(cursor);
  const summary = `Summary (${entry.version?.automatic || entry.manual === false ? 'automatic policy' : 'agent-written'}): ${entry.mark.summary}`;
  const folded = `[context-folding polling id=${entry.id} role=${entry.role}]\n${summary}\nOriginal UTF-16: archived [0,${entry.text.length}); read original for all elapsed readings.\n${result}`;
  return Buffer.byteLength(JSON.stringify(folded)) < Buffer.byteLength(JSON.stringify(entry.text)) ? folded : undefined;
}
