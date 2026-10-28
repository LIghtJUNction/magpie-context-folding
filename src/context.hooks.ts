import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { ConfigError, loadOptions } from './config.js';
import { appendBudget, estimateTokens, withoutBudget } from './budget.js';
import { appendGuidance, defaultRecoveryCommand, withoutGuidance } from './guidance.js';
import { containsRegion, outermost, parseRegions, reference, replaceRegions, type Region } from './annotations.js';
import { addMetrics, emptyMetrics, metricsSchema } from './metrics.js';
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
  return identity === undefined ? span.path : [identity, span.path.slice(2)];
  // @context-fold end occurrenceIdentity-8c0d952a7b
}

interface Candidate { region: Region; occurrence: string; role: 'assistant' | 'tool';
  sourceRanges: NonNullable<NonNullable<Entry['annotation']>['sourceRanges']> }

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
    const seen = new Set<Region>();
    const collectRegion = (region: Region) => {
      if (seen.has(region)) return;
      seen.add(region);
      const origin = byId.get(region.origin.id)!;
      // Marker paths survive replacement of earlier bodies. Content belongs in
      // the immutable node version, not the source/occurrence identity.
      result.push({ region, role, occurrence: fingerprint([region.label,
        region.origin.path.map(item => [occurrenceIdentity(body, byId.get(item.id)!), item.ordinal]), origin.source ?? null]),
        sourceRanges: region.slices.map(slice => {
          const span = byId.get(slice.id)!;
          return { sourceId: fingerprint([role, occurrenceIdentity(body, span), span.source ?? null]),
            sourceHash: digest(span.text), start: slice.start, end: slice.end, offsetUnit: 'utf16' as const };
        }) });
      for (const child of region.children) collectRegion(child.region);
    };
    for (const region of parseRegions(texts)) collectRegion(region);
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
    const body = withoutGuidance(withoutBudget(input, ctx.protocol), ctx.protocol);
    const spans = extractSpans(body, ctx.protocol);
    if (!spans.length || spans.some(span => span.protectedReason)) return input;
    const budgetOptions = {
      reserveOutputTokens: options.reserveOutputTokens,
      ...(options.contextWindowTokens === undefined ? {} : { contextWindowTokens: options.contextWindowTokens }),
    };
    // Recovery uses the host's existing shell, never a registered plugin tool.
    // A shell-less request must retain its input, including all original text.
    if (!recoveryShellName(body, ctx.protocol, options.shellToolName)) return input;
    const store = new Store();
    const command = options.recoveryCommand ?? defaultRecoveryCommand();
    const decorate = (value: Body, scope?: string): Body => {
      const guided = appendGuidance(value, ctx.protocol, { command,
        ...(scope ? { scope, stateDirectory: store.directory } : {}) });
      return options.budgetHints ? appendBudget(guided, ctx.protocol, budgetOptions) : guided;
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
      const byId = new Map(snapshot.entries.map(entry => [entry.id, entry]));
      const found = candidates(body, spans, ctx.protocol);
      const candidateByRegion = new Map(found.map(item => [item.region, item]));
      type Original = { text: string; children: { region: Region; start: number; end: number }[];
        sourceRanges: Candidate['sourceRanges']; referenced?: Entry };
      const resolved = new Map<Region, Original | null>();
      const appendRanges = (target: Candidate['sourceRanges'], ranges: Candidate['sourceRanges']) => {
        for (const range of ranges) {
          const last = target.at(-1);
          if (last?.sourceId === range.sourceId && last.sourceHash === range.sourceHash && last.end === range.start) last.end = range.end;
          else target.push({ ...range });
        }
      };
      const sourceSlice = (ranges: Candidate['sourceRanges'], start: number, end: number) => {
        const result: Candidate['sourceRanges'] = []; let offset = 0;
        for (const range of ranges) {
          const length = range.end - range.start;
          const from = Math.max(start, offset); const to = Math.min(end, offset + length);
          if (from < to) result.push({ ...range, start: range.start + from - offset, end: range.start + to - offset });
          offset += length;
        }
        return result;
      };
      const provenance = (entry: Entry): Candidate['sourceRanges'] => entry.annotation?.sourceRanges ?? [{
        sourceId: 'archive:' + entry.id, sourceHash: digest(entry.text), start: 0, end: entry.text.length, offsetUnit: 'utf16',
      }];
      const resolveReference = (version: number, key: string): Entry | undefined => {
        if (version === 3) return /^[a-f0-9]{64}$/.test(key) ? byId.get(key) : undefined;
        const matches = snapshot.entries.filter(entry => entry.annotation?.sha256.startsWith(key));
        const first = matches[0];
        return first && matches.every(entry => entry.text === first.text && entry.annotation!.sha256 === first.annotation!.sha256)
          ? first : undefined;
      };
      const original = (region: Region): Original | null => {
        if (resolved.has(region)) return resolved.get(region)!;
        if (region.referenceHash) {
          const entry = resolveReference(region.referenceVersion!, region.referenceHash);
          const result = entry ? { text: entry.text, children: [], sourceRanges: provenance(entry), referenced: entry } : null;
          resolved.set(region, result);
          return result;
        }
        let text = ''; let position = 0;
        const sourceRanges: Candidate['sourceRanges'] = [];
        const observed = candidateByRegion.get(region)!.sourceRanges;
        const children: { region: Region; start: number; end: number }[] = [];
        for (const edge of region.children) {
          const prefix = region.text.slice(position, edge.start);
          const child = original(edge.region);
          if (!child || /\[\[cf:/.test(prefix)) { resolved.set(region, null); return null; }
          text += prefix;
          appendRanges(sourceRanges, sourceSlice(observed, position, edge.start));
          const start = text.length;
          text += child.text;
          appendRanges(sourceRanges, child.sourceRanges);
          children.push({ region: edge.region, start, end: text.length });
          position = edge.end;
        }
        const suffix = region.text.slice(position);
        if (/\[\[cf:/.test(suffix)) { resolved.set(region, null); return null; }
        text += suffix;
        appendRanges(sourceRanges, sourceSlice(observed, position, region.text.length));
        const result = { text, children, sourceRanges };
        resolved.set(region, result);
        return result;
      };
      for (const item of found) original(item.region);
      const created = new Set<string>();
      const archived = new Map<Region, Entry>();
      const nodeId = (item: Candidate, parentId: string | null) => fingerprint([
        'fold-node-v3', scope, item.occurrence, digest(original(item.region)!.text), parentId,
      ]);
      const copyReferencedChild = (source: Entry, parentId: string, ordinal: number): Entry => {
        const id = fingerprint(['fold-node-v3-reference-child', scope, parentId, ordinal, digest(source.text)]);
        const existing = byId.get(id);
        if (existing) return existing;
        const entry: Entry = { id, role: source.role, text: source.text, layers: [], mark: { disposition: 'unmarked' },
          annotation: { nodeVersion: 3, sha256: digest(source.text), label: source.annotation!.label, parentId,
            sourceRanges: provenance(source), children: [] } };
        // Hidden descendants retain provenance, but have no separately visible
        // range in this request. Their parent chain leads to the observed reference.
        snapshot.entries.push(entry); byId.set(id, entry); created.add(id);
        entry.annotation!.children = (source.annotation?.children ?? []).map((edge, index) => ({
          id: copyReferencedChild(byId.get(edge.id)!, id, index).id, start: edge.start, end: edge.end,
        }));
        return entry;
      };
      const archive = (region: Region, parentId: string | null): Entry => {
        const previous = archived.get(region);
        if (previous) return previous;
        const item = candidateByRegion.get(region)!;
        const data = original(region)!;
        const id = nodeId(item, parentId);
        let entry = byId.get(id);
        if (!entry) {
          entry = { id, role: item.role, text: data.text,
            annotation: { nodeVersion: 3, sha256: digest(data.text), label: region.label, parentId,
              sourceRanges: data.sourceRanges, observedRanges: item.sourceRanges, children: [] },
            mark: { disposition: 'unmarked' }, layers: [], occurrences: {} };
          snapshot.entries.push(entry); byId.set(id, entry); created.add(id);
        } else if (entry.text !== data.text || entry.annotation?.parentId !== parentId) {
          throw new Error('Archive node identity collision');
        }
        archived.set(region, entry);
        const children = data.referenced ? (data.referenced.annotation?.children ?? []).map((edge, index) => ({
          id: copyReferencedChild(byId.get(edge.id)!, id, index).id, start: edge.start, end: edge.end,
        })) : data.children.map(child => ({ id: archive(child.region, id).id, start: child.start, end: child.end }));
        if (created.has(id)) entry.annotation!.children = children;
        else if (JSON.stringify(entry.annotation!.children ?? []) !== JSON.stringify(children)) {
          throw new Error('Archive node structure changed');
        }
        return entry;
      };
      const eligible = found.filter(item => !item.region.referenceHash && original(item.region));
      const worthwhile = eligible.filter(item => {
        const ref = reference(nodeId(item, null));
        const before = item.region.slices.reduce((sum, slice) => sum + Buffer.byteLength(JSON.stringify(
          spans.find(span => span.id === slice.id)!.text.slice(slice.start, slice.end))), 0);
        const after = item.region.slices.length * Buffer.byteLength(JSON.stringify(ref));
        return after < before && Math.floor((before - after) / 4) >= options.minSavingsTokens;
      });
      // Archive each selected tree once. Even tiny children remain navigable.
      for (const item of outermost(worthwhile)) archive(item.region, null);
      const proposed: { region: Region; reference: string; entry: Entry; occurrence: string }[] = [];
      const waitingIds = new Set<string>();
      let newlyFolded = 0; let waiting = 0; let skipped = eligible.length - worthwhile.length;
      const isWorthwhile = new Set(worthwhile.map(item => item.region));
      for (const item of found) {
        const entry = archived.get(item.region);
        if (!entry || item.region.referenceHash) continue;
        const occurrences = entry.occurrences ??= {};
        let observed = occurrences[item.occurrence];
        if (!observed || observed.lastSeen < previousCycle) observed = occurrences[item.occurrence] = { firstSeen: cycle, lastSeen: cycle };
        observed.lastSeen = cycle;
        if (!isWorthwhile.has(item.region) || entry.mark.disposition === 'keep') continue;
        if (cycle - observed.firstSeen < options.delayRequests) { waiting++; waitingIds.add(entry.id); continue; }
        proposed.push({ region: item.region, reference: reference(entry.id), entry, occurrence: item.occurrence });
      }
      for (const entry of snapshot.entries) if (entry.occurrences) {
        for (const [key, occurrence] of Object.entries(entry.occurrences)) {
          if (occurrence.lastSeen < previousCycle) delete entry.occurrences[key];
        }
      }
      const selected = outermost(proposed);
      const replacements = replaceRegions(spans, selected);
      const existingReferences = spans.filter(span => span.role === 'assistant' || span.source).flatMap(span =>
        [...span.text.matchAll(/\[\[cf:v([23]):([a-f0-9]{12,64})\]\]/g)]
          .filter(match => resolveReference(Number(match[1]), match[2]!)));
      let hasFolded = selected.length > 0 || existingReferences.length > 0;
      let projected = replaceExtractedSpans(body, replacements, ctx.protocol, spans);
      let result = decorate(projected, hasFolded ? scope : undefined);
      const netSaving = estimateTokens(body) - estimateTokens(result);
      const insufficient = selected.length > 0 && (netSaving <= 0 || netSaving < options.minSavingsTokens);
      if (insufficient) {
        skipped += selected.length;
        selected.length = 0;
        // Keep whole waiting trees, never a parent whose children were discarded.
        const retained = new Set<string>();
        const retain = (id: string) => {
          if (retained.has(id)) return;
          retained.add(id);
          const entry = byId.get(id)!;
          for (const child of entry.annotation?.children ?? []) retain(child.id);
          if (entry.annotation?.parentId) retain(entry.annotation.parentId);
        };
        for (const id of waitingIds) retain(id);
        snapshot.entries = snapshot.entries.filter(entry => !created.has(entry.id) || retained.has(entry.id));
        hasFolded = existingReferences.length > 0;
        projected = body;
        result = decorate(body, hasFolded ? scope : undefined);
      }
      // Gross savings count only first-time outer replacements. Nested archive
      // nodes retain their own folded state without recounting their parent's text.
      const newRegions = selected.filter(({ entry, occurrence }) => !entry.occurrences![occurrence]!.folded);
      for (const item of found) {
        const entry = archived.get(item.region);
        if (!entry || !selected.some(parent => parent.region === item.region || containsRegion(parent.region, item.region))) continue;
        entry.folded = reference(entry.id);
        const observed = entry.occurrences?.[item.occurrence];
        if (observed && !observed.folded) { newlyFolded++; observed.folded = true; }
      }
      const projectedHistory = ctx.protocol === 'responses' ? projected.input : ctx.protocol === 'gemini' ? projected.contents : projected.messages;
      snapshot.projectedHash = fingerprint([ctx.protocol, projectedHistory]);
      const requestId = randomUUID();
      snapshot.decision = { reason: hasFolded ? 'annotated-regions-folded' : waiting ? 'annotation-grace-period'
        : skipped ? 'insufficient-net-savings' : 'no-eligible-annotations',
        cycle, waiting, skipped, foldedRegions: selected.length, replayedReferences: existingReferences.length,
        estimatedNetSavings: estimateTokens(body) - estimateTokens(result),
        // Compare the full hook input with its returned projection, including
        // metadata overhead. Archived bytes are not this request's savings.
        beforeBytes: Buffer.byteLength(JSON.stringify(input)), afterBytes: Buffer.byteLength(JSON.stringify(result)),
        observation: { requestId, observedAt: Date.now(), status: 'pending', sessionKey: digest(ctx.session) } };
      if (newlyFolded) snapshot.metrics = addMetrics(snapshot.metrics, {
        foldBatchesApproved: 1, itemsFolded: newlyFolded,
        // A request can replay older folds alongside a newly completed region.
        // Only first-time replacements contribute to cumulative gross savings.
        foldedTokensEstimated: String(Math.max(0, estimateTokens(body) - estimateTokens(
          replaceExtractedSpans(body, replaceRegions(spans, newRegions), ctx.protocol, spans)))),
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
