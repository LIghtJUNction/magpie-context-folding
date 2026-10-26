import { appendGuide, type Protocol } from './protocol.js';

export function estimateTokens(body: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(body)) / 4);
}

/** Capacity is configured, never guessed from model names or undocumented host fields. */
export function appendBudget(body: Record<string, unknown>, protocol: Protocol, capacity?: number,
  guide = ''): Record<string, unknown> {
  const render = (used: number) => {
    const budget = `<context-budget>Current context length estimate: ${used} tokens (complete serialized request UTF-8 bytes / 4; not tokenizer or billing evidence). `
      + (capacity === undefined ? 'Capacity: unknown; used ratio: unknown; remaining: unknown.'
        : `Capacity: ${capacity} tokens (configured); used estimate: ${used}; used ratio estimate: ${(used / capacity * 100).toFixed(2)}%; remaining estimate: ${Math.max(0, capacity - used)} tokens.`)
      + '</context-budget>';
    return appendGuide(body, guide ? `${budget}\n\n${guide}` : budget, protocol);
  };
  // Include the hint itself. Its decimal length converges after a few iterations.
  let used = estimateTokens(body);
  for (let iteration = 0; iteration < 16; iteration++) {
    const result = render(used);
    const next = estimateTokens(result);
    if (next === used) return result;
    used = next;
  }
  // At a digit boundary, conservatively reserve the largest possible hint.
  return render(used);
}
