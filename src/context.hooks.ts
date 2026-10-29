import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { ConfigError, loadOptions } from './config.js';
import { appendGuidanceToCleanBody, containsGuidance, defaultRecoveryCommand, guidanceText } from './guidance.js';
import { cleanRequestBody } from './request-clean.js';
import { containsRegion, outermost, parseRegions, reference, replaceRegions, shortHash, type Region } from './annotations.js';
import { addMetrics, createJsonMeasurementCache, emptyMetrics, metricsSchema, type Metrics } from './metrics.js';
import { extractSpans, projectExtractedSpans, recoveryShellName, type Protocol, type Span } from './protocol.js';
import { Store, digest, type Entry } from './store.js';
import { sourceMarkerOffsets } from './source.js';

type Body = Record<string, unknown>;
const record = (value: unknown): value is Body => !!value && typeof value === 'object' && !Array.isArray(value);
const stateSchema = z.custom<Body>(record);
const pendingKey = 'contextFoldingStatistics';
const pendingSchema = z.object({
  scope: z.string().regex(/^[a-f0-9]{64}$/), bodyHash: z.string(), protocol: z.enum(['chat', 'responses', 'anthropic', 'gemini']).optional(), folded: z.boolean(),
  observeOnly: z.boolean().default(false), successDelta: metricsSchema,
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

interface ResponseUsage {
  inputTokens: bigint;
  outputTokens: bigint;
  cacheReadTokens?: bigint;
  cacheWriteTokens?: bigint;
}

// Normalize only complete, recognized usage fields; never estimate missing counts.
// @context-fold begin parse-response-usage
function tokenCount(value: unknown): bigint | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : undefined;
}

function nullableTokenCount(value: unknown): bigint | undefined {
  return value === null ? 0n : tokenCount(value);
}

function optionalTokenCount(value: unknown): bigint | undefined {
  return value === undefined || value === null ? 0n : tokenCount(value);
}

function responseUsage(reply: unknown, protocol: Protocol | undefined): ResponseUsage | undefined {
  if (!record(reply) || !protocol) return undefined;
  const usageValue = protocol === 'gemini' ? reply.usageMetadata : reply.usage;
  if (!record(usageValue)) return undefined;
  const usage = usageValue;
  let inputTokens: bigint | undefined;
  let outputTokens: bigint | undefined;
  let cacheReadTokens: bigint | undefined;
  let cacheWriteTokens: bigint | undefined;
  if (protocol === 'chat') {
    inputTokens = tokenCount(usage.prompt_tokens);
    outputTokens = tokenCount(usage.completion_tokens);
    const details = record(usage.prompt_tokens_details) ? usage.prompt_tokens_details : undefined;
    if (details) {
      cacheReadTokens = tokenCount(details.cached_tokens);
      cacheWriteTokens = tokenCount(details.cache_write_tokens);
    }
  } else if (protocol === 'responses') {
    inputTokens = tokenCount(usage.input_tokens);
    outputTokens = tokenCount(usage.output_tokens);
    const details = record(usage.input_tokens_details) ? usage.input_tokens_details : undefined;
    if (details) {
      cacheReadTokens = tokenCount(details.cached_tokens);
      cacheWriteTokens = tokenCount(details.cache_write_tokens);
    }
  } else if (protocol === 'anthropic') {
    const uncached = tokenCount(usage.input_tokens);
    const cacheRead = nullableTokenCount(usage.cache_read_input_tokens);
    const cacheWrite = nullableTokenCount(usage.cache_creation_input_tokens);
    inputTokens = uncached !== undefined && cacheRead !== undefined && cacheWrite !== undefined
      ? uncached + cacheRead + cacheWrite : undefined;
    outputTokens = tokenCount(usage.output_tokens);
    cacheReadTokens = cacheRead;
    cacheWriteTokens = cacheWrite;
  } else {
    // Null or omitted optional categories count as zero only when totalTokenCount verifies the sum.
    const prompt = tokenCount(usage.promptTokenCount);
    const toolUse = optionalTokenCount(usage.toolUsePromptTokenCount);
    const candidates = tokenCount(usage.candidatesTokenCount);
    const thoughts = optionalTokenCount(usage.thoughtsTokenCount);
    const total = tokenCount(usage.totalTokenCount);
    if (prompt !== undefined && toolUse !== undefined && candidates !== undefined
      && thoughts !== undefined && total === prompt + toolUse + candidates + thoughts) {
      inputTokens = prompt + toolUse;
      outputTokens = candidates + thoughts;
    }
    cacheReadTokens = tokenCount(usage.cachedContentTokenCount);
  }
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  return { inputTokens, outputTokens,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }) };
}

function responseUsageDelta(reply: unknown, protocol: Protocol | undefined, folded: boolean, observeOnly = false): Partial<Metrics> {
  const usage = responseUsage(reply, protocol);
  const delta: Partial<Metrics> = {};
  const addGroup = (kind: 'folded' | 'unfolded' | 'observeOnly', category: 'requests' | 'unavailable', input?: bigint, output?: bigint) => {
    if (kind === 'observeOnly') {
      if (category === 'unavailable') delta.responseObserveOnlyUsageUnavailableRequests = 1;
      else {
        delta.responseObserveOnlyUsageRequests = 1;
        delta.responseObserveOnlyInputTokens = input!.toString();
        delta.responseObserveOnlyOutputTokens = output!.toString();
      }
    } else if (kind === 'folded') {
      if (category === 'unavailable') delta.responseFoldedUsageUnavailableRequests = 1;
      else {
        delta.responseFoldedUsageRequests = 1;
        delta.responseFoldedInputTokens = input!.toString();
        delta.responseFoldedOutputTokens = output!.toString();
      }
    } else if (category === 'unavailable') delta.responseUnfoldedUsageUnavailableRequests = 1;
    else {
      delta.responseUnfoldedUsageRequests = 1;
      delta.responseUnfoldedInputTokens = input!.toString();
      delta.responseUnfoldedOutputTokens = output!.toString();
    }
  };
  const group = observeOnly ? 'observeOnly' : folded ? 'folded' : 'unfolded';
  if (!usage) {
    delta.responseUsageUnavailableRequests = 1;
    addGroup(group, 'unavailable');
    return delta;
  }
  delta.responseUsageRequests = 1;
  delta.responseInputTokens = usage.inputTokens.toString();
  delta.responseOutputTokens = usage.outputTokens.toString();
  addGroup(group, 'requests', usage.inputTokens, usage.outputTokens);
  if (usage.cacheReadTokens !== undefined) {
    delta.responseCacheReadUsageRequests = 1;
    delta.responseCacheReadTokens = usage.cacheReadTokens.toString();
    if (observeOnly) {
      delta.responseObserveOnlyCacheReadUsageRequests = 1;
      delta.responseObserveOnlyCacheReadTokens = usage.cacheReadTokens.toString();
    } else if (folded) {
      delta.responseFoldedCacheReadUsageRequests = 1;
      delta.responseFoldedCacheReadTokens = usage.cacheReadTokens.toString();
    } else {
      delta.responseUnfoldedCacheReadUsageRequests = 1;
      delta.responseUnfoldedCacheReadTokens = usage.cacheReadTokens.toString();
    }
  }
  if (usage.cacheWriteTokens !== undefined) {
    delta.responseCacheWriteUsageRequests = 1;
    delta.responseCacheWriteTokens = usage.cacheWriteTokens.toString();
    if (observeOnly) {
      delta.responseObserveOnlyCacheWriteUsageRequests = 1;
      delta.responseObserveOnlyCacheWriteTokens = usage.cacheWriteTokens.toString();
    } else if (folded) {
      delta.responseFoldedCacheWriteUsageRequests = 1;
      delta.responseFoldedCacheWriteTokens = usage.cacheWriteTokens.toString();
    } else {
      delta.responseUnfoldedCacheWriteUsageRequests = 1;
      delta.responseUnfoldedCacheWriteTokens = usage.cacheWriteTokens.toString();
    }
  }
  return delta;
}
// @context-fold end parse-response-usage

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

function finalAssistantMessage(item: unknown, protocol: Protocol): boolean {
  if (!record(item)) return false;
  if (protocol === 'gemini') {
    return item.role === 'model' && Array.isArray(item.parts)
      && !item.parts.some(part => record(part) && record(part.functionCall));
  }
  if (protocol === 'anthropic') {
    return item.role === 'assistant' && (typeof item.content === 'string'
      || Array.isArray(item.content) && !item.content.some(part => record(part) && part.type === 'tool_use'));
  }
  if (protocol === 'responses') {
    return item.role === 'assistant' && item.type !== 'function_call' && item.type !== 'custom_tool_call';
  }
  return item.role === 'assistant' && !(Array.isArray(item.tool_calls) && item.tool_calls.length > 0)
    && !('function_call' in item);
}

function refersToSource(question: string, source: NonNullable<Span['source']>, text: string): boolean {
  if (!question.trim()) return true;
  const normalized = question.toLowerCase();
  const filename = source.path.split(/[\\/]/).pop()?.toLowerCase();
  if (filename && normalized.includes(filename)) return true;
  if (/\b(?:this|that|it|these|those|above|previous|earlier|same|file|source|code|function|method|class|variable|identifier|implementation|snippet|module|explain|clarify|elaborate|answer|result|return|value|your answer|you said|you found)\b|它|这|那|上面|前面|之前|刚才|源码|文件|代码|函数|实现|内容|结果|返回|数值|答案|你说|你找到|刚刚/iu.test(question)) return true;
  const identifiers = text.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
  return identifiers.some(identifier => identifier.length >= 3 && /[0-9_$]|[A-Z]/.test(identifier)
    && normalized.includes(identifier.toLowerCase()));
}

interface Candidate { region: Region; occurrence: string; role: 'assistant' | 'tool'; sourceRanges: NonNullable<NonNullable<Entry['annotation']>['observedRanges']> }

function candidates(body: Body, spans: Span[], protocol: Protocol, archivedEntries: readonly Entry[]): Candidate[] {
  // @context-fold begin candidates-9c5f930e91
  const result: Candidate[] = [];
  let conversation: Span[] = [];
  const completeSourceReads = new Map<string, Set<string>>();
  const completeSourceReferences = new Map<string, Set<string>>();
  const archivedByHash = new Map(archivedEntries.filter(entry => entry.annotation)
    .map(entry => [entry.annotation!.sha256, entry]));
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
  const completedRead = (span: Span): boolean => {
    if (span.source?.range !== 'full' || !Array.isArray(history)) return false;
    const nextUser = [...userBoundaries].filter(index => index > span.messageIndex).sort((a, b) => a - b)[0];
    if (nextUser === undefined) return false;
    const question = spans.filter(candidate => candidate.role === 'user' && candidate.messageIndex === nextUser)
      .map(candidate => candidate.text).join('\n');
    if (refersToSource(question, span.source, span.text)) return false;
    return spans.some(answer => answer.role === 'assistant' && answer.messageIndex > span.messageIndex
      && answer.messageIndex < nextUser && finalAssistantMessage(history[answer.messageIndex], protocol));
  };
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
      if (span.source.range === 'full') {
        // Retain completed source on independent later turns; keep a source-related
        // follow-up visible to avoid replacing a likely-needed file with recovery work.
        const eligibleText = span.text.length > 0 && !/@context-fold|\[\[cf:/.test(span.text);
        if (eligibleText && completedRead(span)) {
          const sourceHash = digest(span.text);
          const region: Region = { label: 'completed-source-read', text: span.text, sha256: sourceHash,
            slices: [{ id: span.id, start: 0, end: span.text.length }],
            origin: { id: span.id, ordinal: 0, path: [] }, children: [], hasReferences: false };
          result.push({ region, role: 'tool',
            sourceRanges: [{ sourceId: span.id, sourceHash, start: 0, end: span.text.length, offsetUnit: 'utf16' }],
            occurrence: fingerprint([sourceHash, region.label, occurrenceIdentity(body, span), span.source]) });
        }
        const referenceMatch = /^\[\[cf:v2:([a-f0-9]{12,64})\]\]$/.exec(span.text);
        if (referenceMatch) {
          const matches = archivedEntries.filter(entry => entry.annotation?.sha256.startsWith(referenceMatch[1]!));
          const first = matches[0];
          if (first && matches.every(entry => entry.annotation!.sha256 === first.annotation!.sha256 && entry.text === first.text)) {
            let references = completeSourceReferences.get(span.source.path);
            if (!references) completeSourceReferences.set(span.source.path, references = new Set());
            references.add(first.annotation!.sha256);
          }
        }
        let reads = completeSourceReads.get(span.source.path);
        const repeated = reads?.has(span.text) ?? false;
        if (!reads) completeSourceReads.set(span.source.path, reads = new Set());
        reads.add(span.text);
        const priorReferences = completeSourceReferences.get(span.source.path);
        const hash = eligibleText && (repeated || priorReferences?.size) ? digest(span.text) : undefined;
        const repeatedArchived = hash !== undefined && priorReferences?.has(hash)
          && archivedByHash.get(hash)?.text === span.text;
        // Keep the first full copy visible. Later exact copies can reuse it;
        // or match a valid archived read reference of the same path and content.
        if (eligibleText && (repeated || repeatedArchived)) {
          const sourceHash = hash ?? digest(span.text);
          const region: Region = { label: 'duplicate-source-read', text: span.text, sha256: sourceHash,
            slices: [{ id: span.id, start: 0, end: span.text.length }],
            origin: { id: span.id, ordinal: 0, path: [] }, children: [], hasReferences: false };
          result.push({ region, role: 'tool',
            sourceRanges: [{ sourceId: span.id, sourceHash, start: 0, end: span.text.length, offsetUnit: 'utf16' }],
            occurrence: fingerprint([sourceHash, region.label, occurrenceIdentity(body, span), span.source]) });
        }
      }
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
    if (options.observeOnly) {
      if (!ctx.state) return input;
      const store = new Store();
      const scope = await store.scopeFor(JSON.stringify([ctx.session, ctx.origin ?? '', ctx.agent ?? '', ctx.cwd ?? '']));
      const requestId = randomUUID();
      const requestBytes = Buffer.byteLength(JSON.stringify(input));
      await store.transaction(scope, true, options.maxSessionBytes, snapshot => {
        snapshot.decision = { reason: 'observe-only', beforeBytes: requestBytes, afterBytes: requestBytes,
          foldedRegions: 0, replayedReferences: 0,
          observation: { requestId, observedAt: Date.now(), status: 'pending', sessionKey: digest(ctx.session) } };
      }, ctx.signal, 'preserve');
      ctx.state[pendingKey] = { scope, requestId, bodyHash: fingerprint(input), protocol: ctx.protocol, folded: false,
        observeOnly: true, successDelta: emptyMetrics() };
      return input;
    }
    const hadGuidance = containsGuidance(input, ctx.protocol);
    const measureRequest = createJsonMeasurementCache();
    const body = cleanRequestBody(input, ctx.protocol);
    const spans = extractSpans(body, ctx.protocol);
    if (!spans.length || spans.some(span => span.protectedReason)) return input;
    // Recovery uses the host's existing shell, never a registered plugin tool.
    // A shell-less request must retain its input, including all original text.
    if (!recoveryShellName(body, ctx.protocol, options.shellToolName)) return input;
    const store = new Store();
    const command = options.recoveryCommand ?? defaultRecoveryCommand();
    const decorate = (value: Body, scope?: string): Body => {
      return appendGuidanceToCleanBody(value, ctx.protocol, { command, minSavingsTokens: options.minSavingsTokens,
        ...(scope ? { scope, stateDirectory: store.directory } : {}) });
    };
    // Estimate only the injected instruction and its JSON envelope; serializing a
    // potentially large conversation here would erase the hook's savings.
    const scopedGuide = guidanceText({ command, minSavingsTokens: options.minSavingsTokens,
      scope: '0'.repeat(64), stateDirectory: store.directory });
    const guidanceOverhead = Math.ceil((Buffer.byteLength(JSON.stringify(scopedGuide)) + 64) / 4);
    const contextBytes = spans.reduce((total, span) => total + Buffer.byteLength(span.text), 0);
    const hasRecoveryReference = spans.some(span => span.role !== 'user' && /\[\[cf:v2:/.test(span.text));
    const injectGuidance = hadGuidance || hasRecoveryReference
      || Math.ceil(contextBytes / 4) >= options.minSavingsTokens + guidanceOverhead;
    // Validate the provider's system field before any archive work when guidance is needed.
    const guideOnlyResult = injectGuidance ? decorate(body) : body;
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
      const found = candidates(body, spans, ctx.protocol, snapshot.entries);
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
      let projected = selected.length > 0
        ? projectExtractedSpans(body, replaceRegions(spans, selected), ctx.protocol, spans) : body;
      let result = hasFolded ? decorate(projected, scope) : guideOnlyResult;
      const netSaving = measureRequest(body).estimatedTokens - measureRequest(result).estimatedTokens;
      if (selected.length > 0 && (netSaving <= 0 || netSaving < options.minSavingsTokens)) {
        skipped += selected.length;
        selected = [];
        hasFolded = existingReferences.length > 0;
        projected = body;
        result = hasFolded ? decorate(body, scope) : guideOnlyResult;
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
        }
        // Record provenance on the first commit as well as later observations.
        // Identical replay must not grow an otherwise unchanged archive.
        const candidate = candidateByRegion.get(region);
        if (candidate?.sourceRanges.length) {
          const observedRanges = entry.annotation!.observedRanges ??= [];
          for (const range of candidate.sourceRanges) {
            if (!observedRanges.some(observed => JSON.stringify(observed) === JSON.stringify(range))) observedRanges.push({ ...range });
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
      const previousProjection = projectExtractedSpans(body, replaceRegions(spans, replayedChildren), ctx.protocol, spans);
      const newProjection = projectExtractedSpans(body, replaceRegions(spans, newOutermost), ctx.protocol, spans);
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
      snapshot.projectedHash = projectedHistory === history ? requestHash : fingerprint([ctx.protocol, projectedHistory]);
      const requestId = randomUUID();
      const inputMeasurement = measureRequest(input);
      const bodyMeasurement = measureRequest(body);
      const resultMeasurement = measureRequest(result);
      snapshot.decision = { reason: hasFolded ? 'annotated-regions-folded' : waiting ? 'annotation-grace-period'
        : skipped ? 'insufficient-net-savings' : 'no-eligible-annotations',
        cycle, waiting, skipped, foldedRegions: selected.length, replayedReferences: existingReferences.length,
        estimatedNetSavings: bodyMeasurement.estimatedTokens - resultMeasurement.estimatedTokens,
        beforeBytes: inputMeasurement.bytes, afterBytes: resultMeasurement.bytes,
        observation: { requestId, observedAt: Date.now(), status: 'pending', sessionKey: digest(ctx.session) } };
      if (newlyFolded) snapshot.metrics = addMetrics(snapshot.metrics, {
        foldBatchesApproved: 1, itemsFolded: newlyFolded,
        foldedTokensEstimated: String(Math.max(0,
          measureRequest(previousProjection).estimatedTokens - measureRequest(newProjection).estimatedTokens)),
      });
      pending = { scope, requestId, bodyHash: fingerprint(result), protocol: ctx.protocol, folded: hasFolded, observeOnly: false,
        successDelta: addMetrics(emptyMetrics(), {
          successfulHookRequests: 1, successfulFoldedRequests: hasFolded ? 1 : 0,
          guideOnlyRequests: hasFolded || !injectGuidance ? 0 : 1, replayRequests: hasFolded && !newlyFolded ? 1 : 0,
          estimatedTokenDelta: String(inputMeasurement.estimatedTokens - resultMeasurement.estimatedTokens),
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
    protocol: z.enum(['chat', 'responses', 'anthropic', 'gemini']).optional(),
    signal: z.instanceof(AbortSignal).optional() }).safeParse(context);
  if (!parsed.success) return;
  const ctx = parsed.data;
  const pending = pendingSchema.safeParse(ctx.state[pendingKey]);
  if (!pending.success) return;
  delete ctx.state[pendingKey];
  try {
    const matches = ctx.request !== undefined && fingerprint(ctx.request) === pending.data.bodyHash;
    const delta = ctx.success === false ? pending.data.observeOnly ? { observeOnlyFailedRequests: 1 }
      : { failedHookRequests: 1, failedFoldedRequests: pending.data.folded ? 1 : 0 }
      : ctx.success === true && matches ? { ...(pending.data.observeOnly
        ? { observeOnlySuccessfulRequests: 1 } : pending.data.successDelta),
        ...responseUsageDelta(_reply, ctx.protocol ?? pending.data.protocol, pending.data.folded, pending.data.observeOnly) }
      : pending.data.observeOnly ? { observeOnlyUnverifiedRequests: 1 }
      : { unverifiedHookRequests: 1, unverifiedFoldedRequests: pending.data.folded ? 1 : 0 };
    await new Store().recordMetrics(pending.data.scope, delta, ctx.signal, {
      requestId: pending.data.requestId,
      status: ctx.success === false ? 'failed' : ctx.success === true && matches ? 'confirmed' : 'unverified',
    });
  } catch { /* A missing completion is never counted as verified usage. */ }
  // @context-fold end onResponse-a62b6b6c8b
}
