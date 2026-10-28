import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { ConfigError, loadOptions } from './config.js';
import { withoutRecoveryMetadata } from './recovery.js';
import { appendGuidance, defaultRecoveryCommand, withoutGuidance } from './guidance.js';
import { containsRegion, outermost, parseRegions, reference, replaceRegions, shortHash, type Region } from './annotations.js';
import { addMetrics, emptyMetrics, estimateTokens, metricsSchema } from './metrics.js';
import { extractSpans, recoveryShellName, replaceExtractedSpans, type Protocol, type Span } from './protocol.js';
import { Store, digest, type Entry } from './store.js';
import { sourceMarkerOffsets } from './source.js';

type Body = Record<string, unknown>;
const record = (value: unknown): value is Body => !!value && typeof value === 'object' && !Array.isArray(value);
const stateSchema = z.custom<Body>(record);
const pendingKey = 'contextFoldingStatistics';
const pendingSchema = z.object({
  scope: z.string().regex(/^[a-f0-9]{64}$/), bodyHash: z.string(), folded: z.boolean(), successDelta: metricsSchema,
  requestId: z.string().uuid(),
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

interface Candidate { region: Region; occurrence: string; role: 'assistant' | 'tool'; sourceRanges: NonNullable<NonNullable<Entry['annotation']>['observedRanges']> }

function candidates(body: Body, spans: Span[], protocol: Protocol): Candidate[] {
  // @context-fold begin candidates-9c5f930e91
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
      result.push({ region, role, sourceRanges: region.slices.map(slice => ({ sourceId: slice.id,
        sourceHash: digest(byId.get(slice.id)!.text), start: slice.start, end: slice.end, offsetUnit: 'utf16' })),
        occurrence: fingerprint([region.sha256, region.label,
          region.origin.path.map(item => [occurrenceIdentity(body, byId.get(item.id)!), item.ordinal]), origin.source ?? null]) });
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
  // @context-fold end candidates-9c5f930e91
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
    const body = withoutGuidance(withoutRecoveryMetadata(input, ctx.protocol), ctx.protocol);
    const spans = extractSpans(body, ctx.protocol);
    if (!spans.length || spans.some(span => span.protectedReason)) return input;
    // Recovery uses the host's existing shell, never a registered plugin tool.
    // A shell-less request must retain its input, including all original text.
    if (!recoveryShellName(body, ctx.protocol, options.shellToolName)) return input;
    const store = new Store();
    const command = options.recoveryCommand ?? defaultRecoveryCommand();
    const decorate = (value: Body, scope?: string): Body => {
      return appendGuidance(value, ctx.protocol, { command,
        ...(scope ? { scope, stateDirectory: store.directory } : {}) });
    };
    // Check the real system field before doing any archive work.
    decorate(body);
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
      const found = candidates(body, spans, ctx.protocol);
      const candidateByRegion = new Map(found.map(item => [item.region, item]));
      const resolved = new Map<Region, Entry>();
      const valid = new Map<Region, boolean>();
      // Nested references are child edges only when this exact scope already
      // holds one unambiguous original. Never archive an unknown reference.
      const validate = (region: Region): boolean => {
        if (valid.has(region)) return valid.get(region)!;
        if (region.referenceHash) {
          const matches = snapshot.entries.filter(entry => entry.annotation?.sha256.startsWith(region.referenceHash!));
          const first = matches[0];
          const ok = !!first && matches.every(entry => entry.annotation!.sha256 === first.annotation!.sha256 && entry.text === first.text);
          if (ok) resolved.set(region, first!);
          valid.set(region, ok);
          return ok;
        }
        let visible = region.text;
        let ok = true;
        for (const child of [...region.children].reverse()) {
          if (!validate(child.region)) ok = false;
          visible = visible.slice(0, child.start) + visible.slice(child.end);
        }
        ok &&= !/\[\[cf:/.test(visible);
        valid.set(region, ok);
        return ok;
      };
      for (const { region } of found) validate(region);
      const hashes = new Set([...byHash.keys(), ...snapshot.entries.map(entry => entry.id),
        ...(snapshot.groups ?? []).map(group => group.id),
        ...found.filter(item => valid.get(item.region) && !item.region.referenceHash).map(item => item.region.sha256)]);
      const refFor = (region: Region) => reference(shortHash(resolved.get(region)?.annotation?.sha256 ?? region.sha256, hashes));
      const kept = (region: Region): boolean => (resolved.get(region) ?? byHash.get(region.sha256))?.mark.disposition === 'keep'
        || region.children.some(child => kept(child.region));
      const observations = new Map(found.map(candidate => {
        const previous = byHash.get(candidate.region.sha256)?.occurrences?.[candidate.occurrence];
        const observed = previous && previous.lastSeen >= previousCycle
          ? { ...previous, lastSeen: cycle } : { firstSeen: cycle, lastSeen: cycle, folded: false };
        return [candidate.region, { ...candidate, observed, reference: refFor(candidate.region) }] as const;
      }));
      const proposed: { region: Region; reference: string }[] = [];
      const waitingRegions: Region[] = [];
      let waiting = 0;
      let skipped = 0;
      for (const candidate of observations.values()) {
        const { region, observed, reference: ref } = candidate;
        if (!valid.get(region) || region.referenceHash || kept(region)) continue;
        const before = region.slices.reduce((sum, slice) => sum + Buffer.byteLength(JSON.stringify(
          spans.find(span => span.id === slice.id)!.text.slice(slice.start, slice.end))), 0);
        const after = region.slices.length * Buffer.byteLength(JSON.stringify(ref));
        if (after >= before || Math.floor((before - after) / 4) < options.minSavingsTokens) { skipped++; continue; }
        if (cycle - observed.firstSeen < options.delayRequests) { waiting++; waitingRegions.push(region); continue; }
        proposed.push({ region, reference: ref });
      }
      // Parent/child ranges overlap. Price the actual outermost projection,
      // including all system guidance and recovery paths, before storing it.
      let selected = outermost(proposed);
      const existingReferences = spans.filter(span => span.role === 'assistant' || span.source).flatMap(span =>
        [...span.text.matchAll(/\[\[cf:v2:([a-f0-9]{12,64})\]\]/g)].filter(match =>
          [...byHash.keys()].filter(hash => hash.startsWith(match[1]!)).length === 1));
      let hasFolded = selected.length > 0 || existingReferences.length > 0;
      let projected = replaceExtractedSpans(body, replaceRegions(spans, selected), ctx.protocol, spans);
      let result = decorate(projected, hasFolded ? scope : undefined);
      const netSaving = estimateTokens(body) - estimateTokens(result);
      if (selected.length > 0 && (netSaving <= 0 || netSaving < options.minSavingsTokens)) {
        skipped += selected.length;
        selected = [];
        hasFolded = existingReferences.length > 0;
        projected = body;
        result = decorate(body, hasFolded ? scope : undefined);
      }
      // Commit originals and required descendants only for published folds or
      // legitimate waiting cursors. A rejected batch creates no orphan archive.
      const needed = new Set<Region>();
      const retain = (region: Region) => {
        if (needed.has(region)) return;
        needed.add(region);
        for (const child of region.children) retain(child.region);
      };
      for (const region of waitingRegions) retain(region);
      for (const { region } of selected) retain(region);
      const roles = new Map(found.map(item => [item.region, item.role]));
      const archive = (region: Region): Entry => {
        const old = resolved.get(region);
        if (old) return old;
        const children = region.children.map(child => ({ id: archive(child.region).id, label: child.region.label,
          start: child.start, end: child.end }));
        let entry = byHash.get(region.sha256);
        if (!entry) {
          entry = { id: region.sha256, role: roles.get(region)!, text: region.text,
            annotation: { sha256: region.sha256, label: region.label, ...(children.length ? { children } : {}) },
            mark: { disposition: 'unmarked' }, layers: [], occurrences: {} } satisfies Entry;
          snapshot.entries.push(entry);
          byHash.set(region.sha256, entry);
        } else {
          if (entry.text !== region.text) throw new Error('Annotation content hash mismatch');
          if (children.length && !entry.annotation!.children) entry.annotation!.children = children;
          else if (children.length && JSON.stringify(entry.annotation!.children) !== JSON.stringify(children)) {
            throw new Error('Annotation child structure changed');
          }
          const observedRanges = entry.annotation!.observedRanges ??= [];
          for (const candidate of candidateByRegion.get(region) ? [candidateByRegion.get(region)!] : []) {
            for (const range of candidate.sourceRanges) {
              if (!observedRanges.some(observed => JSON.stringify(observed) === JSON.stringify(range))) observedRanges.push({ ...range });
            }
          }
          if (observedRanges.length > 64) observedRanges.splice(0, observedRanges.length - 64);
        }
        resolved.set(region, entry);
        return entry;
      };
      for (const region of needed) archive(region);
      const published = [...observations.values()].filter(item => !item.region.referenceHash
        && selected.some(outer => outer.region === item.region || containsRegion(outer.region, item.region)));
      const newRegions = published.filter(item => !item.observed.folded);
      const newlyFolded = newRegions.length;
      // Count only new outermost replacements. Older children inside a new
      // parent already contributed savings; unrelated replayed siblings must
      // remain identical on both sides of this incremental estimate.
      const newOutermost = outermost(newRegions);
      const replayedChildren = published.filter(item => item.observed.folded
        && newOutermost.some(outer => containsRegion(outer.region, item.region)));
      const previousProjection = replaceExtractedSpans(body, replaceRegions(spans, replayedChildren), ctx.protocol, spans);
      const newProjection = replaceExtractedSpans(body, replaceRegions(spans, newOutermost), ctx.protocol, spans);
      for (const candidate of observations.values()) {
        if (!valid.get(candidate.region) || candidate.region.referenceHash) continue;
        const entry = resolved.get(candidate.region) ?? byHash.get(candidate.region.sha256);
        // A rejected mature candidate can already have a durable waiting
        // cursor. Refresh it without creating a new archive for this batch.
        if (!entry) continue;
        (entry.occurrences ??= {})[candidate.occurrence] = candidate.observed;
      }
      for (const candidate of published) {
        const entry = resolved.get(candidate.region)!;
        entry.folded = candidate.reference;
        candidate.observed.folded = true;
      }
      // Occurrence metadata is a cursor; archived originals remain durable.
      for (const entry of snapshot.entries) if (entry.occurrences) {
        for (const [key, occurrence] of Object.entries(entry.occurrences)) {
          if (occurrence.lastSeen < previousCycle) delete entry.occurrences[key];
        }
      }
      const projectedHistory = ctx.protocol === 'responses' ? projected.input : ctx.protocol === 'gemini' ? projected.contents : projected.messages;
      snapshot.projectedHash = fingerprint([ctx.protocol, projectedHistory]);
      const requestId = randomUUID();
      snapshot.decision = { reason: hasFolded ? 'annotated-regions-folded' : waiting ? 'annotation-grace-period'
        : skipped ? 'insufficient-net-savings' : 'no-eligible-annotations',
        cycle, waiting, skipped, foldedRegions: selected.length, replayedReferences: existingReferences.length,
        estimatedNetSavings: estimateTokens(body) - estimateTokens(result),
        beforeBytes: Buffer.byteLength(JSON.stringify(input)), afterBytes: Buffer.byteLength(JSON.stringify(result)),
        observation: { requestId, observedAt: Date.now(), status: 'pending', sessionKey: digest(ctx.session) } };
      if (newlyFolded) snapshot.metrics = addMetrics(snapshot.metrics, {
        foldBatchesApproved: 1, itemsFolded: newlyFolded,
        foldedTokensEstimated: String(Math.max(0, estimateTokens(previousProjection) - estimateTokens(newProjection))),
      });
      pending = { scope, requestId, bodyHash: fingerprint(result), folded: hasFolded,
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
    await new Store().recordMetrics(pending.data.scope, delta, ctx.signal, {
      requestId: pending.data.requestId,
      status: ctx.success === false ? 'failed' : ctx.success === true && matches ? 'confirmed' : 'unverified',
    });
  } catch { /* A missing completion is never counted as verified usage. */ }
  // @context-fold end onResponse-a62b6b6c8b
}
