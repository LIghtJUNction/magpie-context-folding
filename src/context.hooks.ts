import { z } from 'zod';
import { ConfigError, loadOptions } from './config.js';
import { appendBudget, estimateTokens, withoutBudget } from './budget.js';
import { parseRegions, reference, replaceRegions, shortHash, type Region } from './annotations.js';
import { addMetrics, emptyMetrics, metricsSchema } from './metrics.js';
import { extractSpans, recoveryToolName, replaceExtractedSpans, type Protocol, type Span } from './protocol.js';
import { Store, digest, type Entry } from './store.js';
import { sourceMarkerOffsets } from './source.js';

type Body = Record<string, unknown>;
const record = (value: unknown): value is Body => !!value && typeof value === 'object' && !Array.isArray(value);
const stateSchema = z.custom<Body>(record);
const pendingKey = 'contextFoldingStatistics';
const pendingSchema = z.object({
  scope: z.string().regex(/^[a-f0-9]{64}$/), bodyHash: z.string(), folded: z.boolean(), successDelta: metricsSchema,
});
const contextSchema = z.object({
  protocol: z.enum(['chat', 'responses', 'anthropic', 'gemini']), model: z.string(), session: z.string().min(1),
  origin: z.string().optional(), agent: z.string().optional(), cwd: z.string().optional(), options: z.unknown().optional(),
  signal: z.instanceof(AbortSignal).optional(), state: stateSchema.optional(),
});

function fingerprint(value: unknown): string {
  return digest(JSON.stringify(value, (_key, current: unknown) => record(current)
    ? Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b))) : current) ?? '');
}

/** IDs distinguish a fresh Read from an old occurrence of identical source. */
function occurrenceIdentity(body: Body, span: Span): unknown {
  let current: unknown = body;
  let identity: unknown;
  for (const part of span.path) {
    if (record(current)) {
      identity = current.tool_call_id ?? current.tool_use_id ?? current.call_id ?? current.id ?? identity;
      if (record(current.functionResponse)) identity = current.functionResponse.id ?? identity;
    }
    if (!current || typeof current !== 'object') break;
    current = (current as Record<string | number, unknown>)[part];
  }
  return identity ?? span.path;
}

interface Candidate { region: Region; occurrence: string; role: 'assistant' | 'tool' }

function candidates(body: Body, spans: Span[], protocol: Protocol): Candidate[] {
  const result: Candidate[] = [];
  let conversation: Span[] = [];
  const collect = (parts: Span[], role: 'assistant' | 'tool') => {
    const byId = new Map(parts.map(part => [part.id, part]));
    const texts = parts.map(part => {
      const offsets = part.source ? sourceMarkerOffsets(part.text, part.source.path) : undefined;
      return offsets === undefined ? part : { ...part, markerOffsets: offsets };
    });
    for (const region of parseRegions(texts)) {
      const origin = byId.get(region.origin.id)!;
      // Marker order survives earlier replacements in the same message; byte
      // offsets and content-derived span IDs do not.
      result.push({ region, role, occurrence: fingerprint([region.sha256, region.label,
        occurrenceIdentity(body, origin), region.origin.ordinal, origin.source ?? null]) });
    }
  };
  const history = protocol === 'responses' ? body.input : protocol === 'gemini' ? body.contents : body.messages;
  const userBoundaries = new Set<number>();
  if (Array.isArray(history)) history.forEach((item: unknown, index) => {
    if (!record(item) || item.role !== 'user') return;
    const parts = protocol === 'gemini' ? item.parts : item.content;
    // Providers wrap tool results in user messages. Every other user message,
    // including images and empty text, ends an open assistant annotation.
    const onlyToolResults = Array.isArray(parts) && parts.length > 0 && parts.every(part => record(part)
      && (protocol === 'anthropic' ? part.type === 'tool_result' : protocol === 'gemini' && record(part.functionResponse)));
    if (!onlyToolResults) userBoundaries.add(index);
  });
  let previousIndex = -1;
  for (const span of spans) {
    if ([...userBoundaries].some(index => index > previousIndex && index <= span.messageIndex)) {
      collect(conversation, 'assistant');
      conversation = [];
    }
    previousIndex = span.messageIndex;
    if (span.role === 'assistant') conversation.push(span);
    else if (span.role === 'tool' && span.source && span.activityReason !== 'plugin-control') {
      // Only a verified single textual Read result is a source view. Generic
      // tool output, call arguments, receipts and recovery results stay intact.
      collect([span], 'tool');
    }
  }
  collect(conversation, 'assistant');
  return result;
}

export async function onRequest(input: unknown, context: unknown): Promise<unknown> {
  const parsed = contextSchema.safeParse(context);
  if (!record(input) || !parsed.success) return input;
  const ctx = parsed.data;
  if (ctx.state) delete ctx.state[pendingKey];
  try {
    ctx.signal?.throwIfAborted();
    const options = await loadOptions(ctx.options, ctx.cwd);
    if (!options.enabled) return input;
    const body = withoutBudget(input, ctx.protocol);
    const spans = extractSpans(body, ctx.protocol);
    if (!spans.length || spans.some(span => span.protectedReason)) return input;
    const budgetOptions = {
      reserveOutputTokens: options.reserveOutputTokens,
      ...(options.contextWindowTokens === undefined ? {} : { contextWindowTokens: options.contextWindowTokens }),
    };
    // A visible budget is useful even when this host cannot recover originals.
    if (!recoveryToolName(body, ctx.protocol, options.recoveryToolName)) return appendBudget(body, ctx.protocol, budgetOptions);
    const store = new Store();
    const scope = await store.scopeFor(JSON.stringify([ctx.session, ctx.origin ?? '', ctx.agent ?? '', ctx.cwd ?? '']));
    let pending: z.infer<typeof pendingSchema> | undefined;
    const output = await store.transaction(scope, true, options.maxSessionBytes, snapshot => {
      const history = ctx.protocol === 'responses' ? body.input : ctx.protocol === 'gemini' ? body.contents : body.messages;
      const requestHash = fingerprint([ctx.protocol, history]);
      const previousCycle = snapshot.cycle ?? 0;
      const cycle = snapshot.requestHash === undefined || snapshot.requestHash === requestHash || snapshot.projectedHash === requestHash
        ? previousCycle : previousCycle + 1;
      snapshot.cycle = cycle;
      if (requestHash !== snapshot.projectedHash) snapshot.requestHash = requestHash;
      const byHash = new Map(snapshot.entries.filter(entry => entry.annotation).map(entry => [entry.annotation!.sha256, entry]));
      const proposed: { region: Region; reference: string }[] = [];
      const found = candidates(body, spans, ctx.protocol);
      // Allocate references against the entire batch so collision handling is
      // independent of parse order. Full hashes and original text stay in storage.
      const hashes = new Set([...byHash.keys(), ...snapshot.entries.map(entry => entry.id),
        ...(snapshot.groups ?? []).map(group => group.id), ...found.map(candidate => candidate.region.sha256)]);
      let newlyFolded = 0;
      let waiting = 0;
      for (const { region, occurrence, role } of found) {
        const ref = reference(shortHash(region.sha256, hashes));
        const before = region.slices.reduce((sum, slice) => sum + Buffer.byteLength(JSON.stringify(
          spans.find(span => span.id === slice.id)!.text.slice(slice.start, slice.end))), 0);
        const after = region.slices.length * Buffer.byteLength(JSON.stringify(ref));
        if (after >= before) continue;
        let entry = byHash.get(region.sha256);
        if (!entry) {
          entry = { id: region.sha256, role, text: region.text, annotation: { sha256: region.sha256, label: region.label },
            mark: { disposition: 'unmarked' }, layers: [], occurrences: {} } satisfies Entry;
          snapshot.entries.push(entry);
          byHash.set(region.sha256, entry);
        } else if (entry.text !== region.text) throw new Error('Annotation content hash mismatch');
        const occurrences = entry.occurrences ??= {};
        let observed = occurrences[occurrence];
        // Reappearing history gets a new grace period. The content hash alone
        // can never make a freshly read occurrence immediately disappear.
        if (!observed || observed.lastSeen < previousCycle) observed = occurrences[occurrence] = { firstSeen: cycle, lastSeen: cycle };
        observed.lastSeen = cycle;
        if (entry.mark.disposition === 'keep') continue;
        if (cycle - observed.firstSeen < options.delayRequests) { waiting++; continue; }
        proposed.push({ region, reference: ref });
        entry.folded = ref;
        if (!observed.folded) { newlyFolded++; observed.folded = true; }
      }
      // Occurrence metadata is a short-lived cursor; originals and old references
      // are durable until explicitly forgotten, never evicted to meet a budget.
      for (const entry of snapshot.entries) if (entry.occurrences) {
        for (const [key, occurrence] of Object.entries(entry.occurrences)) {
          if (occurrence.lastSeen < previousCycle) delete entry.occurrences[key];
        }
      }
      const replacements = replaceRegions(spans, proposed);
      const existingReferences = spans.filter(span => span.role === 'assistant' || span.source).flatMap(span =>
        [...span.text.matchAll(/\[\[cf:v2:([a-f0-9]{12,64})\]\]/g)].filter(match =>
          [...byHash.keys()].filter(hash => hash.startsWith(match[1]!)).length === 1));
      const hasFolded = proposed.length > 0 || existingReferences.length > 0;
      const projected = replaceExtractedSpans(body, replacements, ctx.protocol, spans);
      const projectedHistory = ctx.protocol === 'responses' ? projected.input : ctx.protocol === 'gemini' ? projected.contents : projected.messages;
      snapshot.projectedHash = fingerprint([ctx.protocol, projectedHistory]);
      const result = appendBudget(projected, ctx.protocol, { ...budgetOptions, scope });
      snapshot.decision = { reason: hasFolded ? 'annotated-regions-folded' : waiting ? 'annotation-grace-period' : 'no-eligible-annotations',
        cycle, waiting, foldedRegions: proposed.length, replayedReferences: existingReferences.length };
      if (newlyFolded) snapshot.metrics = addMetrics(snapshot.metrics, {
        foldBatchesApproved: 1, itemsFolded: newlyFolded,
        foldedTokensEstimated: String(Math.max(0, estimateTokens(body) - estimateTokens(projected))),
      });
      pending = { scope, bodyHash: fingerprint(result), folded: hasFolded,
        successDelta: addMetrics(emptyMetrics(), {
          successfulHookRequests: 1, successfulFoldedRequests: hasFolded ? 1 : 0,
          guideOnlyRequests: hasFolded ? 0 : 1, replayRequests: hasFolded && !newlyFolded ? 1 : 0,
          estimatedTokenDelta: String(estimateTokens(input) - estimateTokens(result)),
        }) };
      return result;
    }, ctx.signal);
    if (ctx.state && pending) ctx.state[pendingKey] = pending;
    return output;
  } catch (error) {
    if (error instanceof ConfigError) console.error(`[context-folding] ${error.message}`);
    // The transaction must commit every original before a changed request escapes.
    return input;
  }
}

export async function onResponse(_reply: unknown, context: unknown): Promise<void> {
  const parsed = z.object({ state: stateSchema, success: z.boolean().optional(), request: z.unknown().optional(),
    signal: z.instanceof(AbortSignal).optional() }).safeParse(context);
  if (!parsed.success) return;
  const ctx = parsed.data;
  const pending = pendingSchema.safeParse(ctx.state[pendingKey]);
  if (!pending.success) return;
  delete ctx.state[pendingKey];
  try {
    const matches = ctx.request !== undefined && fingerprint(ctx.request) === pending.data.bodyHash;
    const delta = ctx.success === false ? { failedHookRequests: 1, failedFoldedRequests: pending.data.folded ? 1 : 0 }
      : ctx.success === true && matches ? pending.data.successDelta
      : { unverifiedHookRequests: 1, unverifiedFoldedRequests: pending.data.folded ? 1 : 0 };
    await new Store().recordMetrics(pending.data.scope, delta, ctx.signal);
  } catch { /* A missing completion is never counted as verified usage. */ }
}
