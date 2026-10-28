import { z } from 'zod';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { ConfigError, loadOptions } from './config.js';
import { appendBudget, estimateTokens, withoutBudget } from './budget.js';
import { parseRegions, reference, replaceRegions, shortHash, type Region } from './annotations.js';
import { addMetrics, emptyMetrics, metricsSchema } from './metrics.js';
import { extractSpans, replaceExtractedSpans, type Protocol, type Span } from './protocol.js';
import { Store, digest, type Entry } from './store.js';
import { sourceMarkerOffsets } from './source.js';
import { conversationEntry, conversationId, conversationReference } from './fold.js';
import { conversationRangesFromMarkers, projectConversationRanges, selectConversationRange, type ConversationSelection } from './ranges.js';

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
  // @context-fold begin occurrenceIdentity-8c0d952a7b
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
  // @context-fold end occurrenceIdentity-8c0d952a7b
}

interface Candidate { region: Region; occurrence: string; role: 'assistant' | 'tool' }

function candidates(body: Body, spans: Span[], archiveDirectory: string, cwd: string): Candidate[] {
  const result: Candidate[] = [];
  for (const span of spans) {
    if (span.role !== 'tool' || !span.source || span.activityReason === 'plugin-control') continue;
    let sourcePath = resolve(cwd, span.source.path);
    try { sourcePath = realpathSync(sourcePath); } catch { /* Remote source paths can be absent locally. */ }
    const local = relative(archiveDirectory, sourcePath);
    // A normal Read of a saved archive is recovery, even without a dedicated
    // tool name. Historical markers inside it are data, never fresh directives.
    if (!isAbsolute(local) && local !== '..' && !local.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) continue;
    const offsets = sourceMarkerOffsets(span.text, span.source.path);
    for (const region of parseRegions([{ ...span, ...(offsets === undefined ? {} : { markerOffsets: offsets }) }])) {
      result.push({ region, role: 'tool', occurrence: fingerprint([region.sha256, region.label,
        occurrenceIdentity(body, span), region.origin.ordinal, span.source]) });
    }
  }
  return result;
}

export async function onRequest(input: unknown, context: unknown): Promise<unknown> {
  // @context-fold begin onRequest-d395c56e62
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
    if (!options.fileAccess) return appendBudget(body, ctx.protocol, budgetOptions);
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
      const conversationEdits: { selection: ConversationSelection; referenceText: string }[] = [];
      const marked = conversationRangesFromMarkers(body, ctx.protocol).map(item => ({ ...item,
        selection: selectConversationRange(body, ctx.protocol, item.range) }));
      const found = candidates(body, spans, resolve(store.directory, 'archives'), ctx.cwd ?? process.cwd()).filter(candidate => {
        const index = spans.find(span => span.id === candidate.region.origin.id)!.messageIndex;
        return !marked.some(item => index >= item.range.start.message
          && (index < item.range.end.message || index === item.range.end.message && (item.range.end.offset ?? 0) > 0));
      });
      // Allocate references against the entire batch so collision handling is
      // independent of parse order. Full hashes and original text stay in storage.
      const hashes = new Set([...byHash.keys(), ...snapshot.entries.map(entry => entry.id),
        ...(snapshot.groups ?? []).map(group => group.id), ...found.map(candidate => candidate.region.sha256), ...marked.map(item => conversationId(item.selection))]);
      let newlyFolded = 0;
      let waiting = 0;
      const contentOccurrences = new Map<string, number>();
      for (const { label, selection } of marked) {
        const identity = conversationId(selection);
        let entry = byHash.get(identity);
        const candidate = entry ?? conversationEntry(selection, label);
        const referenceText = conversationReference(store, scope, candidate, hashes);
        const preview = projectConversationRanges(body, ctx.protocol, [{ selection, referenceText }]);
        if (Buffer.byteLength(JSON.stringify(preview)) >= Buffer.byteLength(JSON.stringify(body))) continue;
        if (!entry) { entry = candidate; snapshot.entries.push(entry); byHash.set(identity, entry); }
        if (entry.transcript !== selection.transcript || entry.text !== selection.text) throw new Error('Archive content hash mismatch');
        const ordinal = contentOccurrences.get(selection.contentIdentity) ?? 0;
        contentOccurrences.set(selection.contentIdentity, ordinal + 1);
        const occurrence = fingerprint(['conversation', label, selection.contentIdentity, ordinal]);
        const occurrences = entry.occurrences ??= {};
        const prior = snapshot.entries.find(item => item !== entry && item.contentIdentity === selection.contentIdentity
          && item.occurrences?.[occurrence] && item.occurrences[occurrence]!.lastSeen >= previousCycle);
        let observed = occurrences[occurrence] ?? (prior?.occurrences?.[occurrence]
          ? occurrences[occurrence] = { ...prior.occurrences[occurrence]! } : undefined);
        if (!observed || observed.lastSeen < previousCycle) observed = occurrences[occurrence] = { firstSeen: cycle, lastSeen: cycle };
        observed.lastSeen = cycle;
        if (entry.mark.disposition === 'keep' || prior?.mark.disposition === 'keep') continue;
        if (cycle - observed.firstSeen < options.delayRequests) { waiting++; continue; }
        conversationEdits.push({ selection, referenceText });
        entry.folded = referenceText;
        if (!observed.folded) { newlyFolded++; observed.folded = true; }
      }
      for (const { region, occurrence, role } of found) {
        const ref = reference(shortHash(region.sha256, hashes), store.paths(scope, { text: region.text }).path);
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
      const existingReferences = spans.flatMap(span =>
        [...span.text.matchAll(/\[\[cf:v[23]:([a-f0-9]{12,64})(?:\]\]| path=)/g)].filter(match =>
          [...byHash.keys()].filter(hash => hash.startsWith(match[1]!)).length === 1));
      const hasFolded = proposed.length > 0 || conversationEdits.length > 0 || existingReferences.length > 0;
      const sourceProjection = replaceExtractedSpans(body, replacements, ctx.protocol, spans);
      const projected = projectConversationRanges(sourceProjection, ctx.protocol, conversationEdits);
      const projectedHistory = ctx.protocol === 'responses' ? projected.input : ctx.protocol === 'gemini' ? projected.contents : projected.messages;
      snapshot.projectedHash = fingerprint([ctx.protocol, projectedHistory]);
      const result = appendBudget(projected, ctx.protocol, { ...budgetOptions, scope });
      snapshot.decision = { reason: hasFolded ? 'annotated-regions-folded' : waiting ? 'annotation-grace-period' : 'no-eligible-annotations',
        cycle, waiting, foldedRegions: proposed.length + conversationEdits.length, replayedReferences: existingReferences.length };
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
  // @context-fold end onRequest-d395c56e62
}

export async function onResponse(_reply: unknown, context: unknown): Promise<void> {
  // @context-fold begin onResponse-a62b6b6c8b
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
  // @context-fold end onResponse-a62b6b6c8b
}
