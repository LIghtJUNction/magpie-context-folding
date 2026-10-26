import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { incrementalCostsSchema, proveSavings, type Certificate, type SavingsProof } from './economics.js';
import type { Protocol, Span } from './protocol.js';

const money = z.number().finite().nonnegative();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const rateSchema = z.object({ lower: money, upper: money }).strict()
  .refine(value => value.lower <= value.upper, 'lower must not exceed upper');
const argumentSchema = z.string().refine(value => !value.includes('\0'), 'NUL is not allowed');
export const scriptSchema = z.object({
  command: z.tuple([argumentSchema.refine(isAbsolute, 'Executable must be an absolute path')]).rest(argumentSchema),
  timeoutMs: z.number().int().min(1).max(60_000).default(1000),
  maxOutputBytes: z.number().int().min(1).max(1_048_576).default(65_536),
  maxInputBytes: z.number().int().min(1).max(67_108_864).default(8_388_608),
  maxSummaryChars: z.number().int().min(1).max(16_384).default(2000),
}).strict();

export const policySchema = z.object({
  mode: z.enum(['bytes', 'cost']).default('cost'),
  autoRoles: z.array(z.enum(['user', 'assistant', 'tool'])).max(3)
    .refine(value => new Set(value).size === value.length, 'Duplicate roles').default([]),
  minChars: count.default(4096),
  summaryChars: z.number().int().min(256).max(2000).default(1000),
  minimumSavingUsd: money.default(0),
  cost: z.object({
    bytesPerTokenLower: z.number().finite().positive().default(1),
    bytesPerTokenUpper: z.number().finite().positive().default(8),
    input: rateSchema,
    cacheRead: rateSchema,
    cacheWrite: rateSchema,
    outputPricePerMillion: money.default(0),
    overheadUsd: money.default(0),
    outputTokens: count.default(0),
    restoreTokens: count.default(0),
    incremental: incrementalCostsSchema.optional(),
  }).strict().refine(value => value.bytesPerTokenLower <= value.bytesPerTokenUpper,
    'bytesPerTokenLower must not exceed bytesPerTokenUpper').optional(),
  script: scriptSchema.optional(),
  certificateScript: scriptSchema.optional(),
}).strict();

export type Policy = z.infer<typeof policySchema>;
export type PolicyInput = z.input<typeof policySchema>;
export type Script = z.infer<typeof scriptSchema>;

export interface PolicyRequest {
  model: string;
  protocol: Protocol;
  /** Complete bodies, including tools, system text, folding markers, and guide. */
  before: unknown;
  after: unknown;
}

export function policyRequestHash(request: PolicyRequest): string {
  return createHash('sha256').update(JSON.stringify({
    model: request.model, protocol: request.protocol, before: request.before, after: request.after,
  })).digest('hex');
}

/** Trusted local executable; never invokes a shell. Both output streams share a byte budget. */
async function runScript(script: Script, context: unknown, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  const input = JSON.stringify(context);
  if (Buffer.byteLength(input) > script.maxInputBytes) throw new Error('Policy script input limit exceeded');
  return new Promise((resolve, reject) => {
    const [executable, ...args] = script.command;
    const grouped = process.platform !== 'win32';
    const child = spawn(executable, args, { shell: false, detached: grouped, stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false;
    let outputBytes = 0;
    const chunks: Buffer[] = [];
    const kill = () => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* Process already exited. */ }
    };
    const finish = (error?: unknown, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      kill();
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      if (error !== undefined) reject(error);
      else resolve(result);
    };
    const abort = () => finish(signal?.reason ?? new Error('Policy script aborted'));
    const timer = setTimeout(() => finish(new Error('Policy script timed out')), script.timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    const receive = (chunk: Buffer, stdout: boolean) => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > script.maxOutputBytes) finish(new Error('Policy script output limit exceeded'));
      else if (stdout) chunks.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => receive(chunk, true));
    child.stderr.on('data', (chunk: Buffer) => receive(chunk, false));
    child.on('error', error => finish(error));
    child.stdin.on('error', error => finish(error));
    child.on('close', code => {
      if (settled) return;
      if (code !== 0) { finish(new Error(`Policy script exited with code ${code}`)); return; }
      try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { finish(new Error('Policy script must return one JSON value')); }
    });
    child.stdin.end(input);
  });
}

export interface CandidateMark {
  id: string;
  disposition: 'foldable' | 'keep';
  summary?: string | undefined;
}

function automaticSummary(span: Span, limit: number): string {
  const render = (length: number) => `Archived ${span.role} text (${span.text.length} UTF-16 characters). Verbatim excerpts (incomplete): opening=${JSON.stringify(span.text.slice(0, length))}; ending=${JSON.stringify(span.text.slice(-length || span.text.length))}; read the original for details.`;
  let length = Math.floor(limit / 4);
  let result = render(length);
  while (result.length > limit && length > 0) {
    length = Math.floor(length / 2);
    result = render(length);
  }
  return result;
}

/** Scripts select only eligible spans supplied by the hook; this function never mutates a request. */
export async function planCandidates(input: {
  policy: PolicyInput;
  spans: readonly Span[];
  model: string;
  protocol: Protocol;
  signal?: AbortSignal;
}): Promise<{ marks: CandidateMark[] }> {
  const policy = policySchema.parse(input.policy);
  input.signal?.throwIfAborted();
  if (new Set(input.spans.map(span => span.id)).size !== input.spans.length) {
    throw new Error('Duplicate policy candidate IDs');
  }
  const eligible = input.spans.filter(span => span.protectedReason === undefined
    && policy.autoRoles.includes(span.role) && span.text.length >= policy.minChars);
  if (!policy.script) return { marks: eligible.map(span => ({
    id: span.id, disposition: 'foldable',
    summary: automaticSummary(span, policy.summaryChars),
  })) };
  if (eligible.length === 0) return { marks: [] };
  const response = await runScript(policy.script, {
    version: 1, kind: 'candidates', model: input.model, protocol: input.protocol,
    spans: eligible.map(({ id, role, text, messageIndex }) => ({ id, role, text, messageIndex })),
  }, input.signal);
  const markSchema = z.object({
    id: z.string().min(1), disposition: z.enum(['foldable', 'keep']),
    summary: z.string().trim().min(1).max(policy.script.maxSummaryChars).optional(),
  }).strict().refine(mark => mark.disposition !== 'keep' || mark.summary === undefined,
    'Keep marks must not supply summaries');
  const result = z.object({ marks: z.array(markSchema).max(eligible.length) }).strict().parse(response);
  const ids = new Set(eligible.map(span => span.id));
  const seen = new Set<string>();
  for (const mark of result.marks) {
    if (!ids.has(mark.id) || seen.has(mark.id)) throw new Error('Unknown or duplicate policy script ID');
    seen.add(mark.id);
  }
  return result;
}

// Interpret the configured Number's decimal representation exactly, then divide integers.
function tokensForBytes(bytes: number, bytesPerToken: number, upper: boolean): number {
  const [mantissa = '0', exponent = '0'] = bytesPerToken.toString().split('e');
  const [whole = '0', fraction = ''] = mantissa.split('.');
  const scale = fraction.length - Number(exponent);
  const coefficient = BigInt(whole + fraction);
  const numerator = BigInt(bytes) * 10n ** BigInt(Math.max(scale, 0));
  const denominator = coefficient * 10n ** BigInt(Math.max(-scale, 0));
  const result = (numerator + (upper ? denominator - 1n : 0n)) / denominator;
  return result > BigInt(Number.MAX_SAFE_INTEGER) ? Infinity : Number(result);
}

function roundUp(value: number): number {
  if (value === 0 || !Number.isFinite(value)) return value;
  const bytes = new DataView(new ArrayBuffer(8));
  bytes.setFloat64(0, value);
  bytes.setBigUint64(0, bytes.getBigUint64(0) + 1n);
  return bytes.getFloat64(0);
}

function upperTokenCost(tokens: number, rate: number): number {
  if (tokens === 0 || rate === 0) return 0;
  const value = roundUp(tokens * rate) / 1_000_000;
  return value === 0 ? Number.MIN_VALUE : roundUp(value);
}

/** A single request comparison. Byte/token bounds are explicit caller assumptions, not tokenization. */
export async function evaluatePolicy(input: PolicyRequest & {
  policy: PolicyInput;
  certificate?: unknown;
  signal?: AbortSignal;
  now?: number;
}): Promise<SavingsProof> {
  const parsed = policySchema.safeParse(input.policy);
  if (!parsed.success) return { approved: false, reason: 'invalid-policy' };
  const policy = parsed.data;
  input.signal?.throwIfAborted();
  const before = JSON.stringify(input.before);
  const after = JSON.stringify(input.after);
  if (before === undefined || after === undefined) return { approved: false, reason: 'invalid-policy-request' };
  const beforeBytes = Buffer.byteLength(before);
  const afterBytes = Buffer.byteLength(after);
  if (policy.mode === 'bytes') return {
    approved: afterBytes < beforeBytes,
    reason: afterBytes < beforeBytes ? 'bytes-smaller-no-cost-proof' : 'batch-not-smaller',
  };
  const requestHash = policyRequestHash(input);
  const now = input.now ?? Date.now();
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now + 60_000).getTime())) {
    return { approved: false, reason: 'invalid-proof-settings' };
  }
  const proofInput = { requestHash, model: input.model, protocol: input.protocol,
    minimumSavingUsd: policy.minimumSavingUsd, now };
  if (input.certificate !== undefined) return proveSavings({ ...proofInput, certificate: input.certificate });
  if (policy.certificateScript) {
    try {
      const certificate = await runScript(policy.certificateScript, {
        version: 1, kind: 'certificate', requestHash, model: input.model, protocol: input.protocol,
        before: input.before, after: input.after,
      }, input.signal);
      input.signal?.throwIfAborted();
      return proveSavings({ ...proofInput, certificate });
    } catch {
      input.signal?.throwIfAborted();
      return { approved: false, reason: 'policy-certificate-script-failed' };
    }
  }
  const cost = policy.cost;
  if (!cost) return { approved: false, reason: 'policy-cost-bounds-missing' };
  if (!cost.incremental) return { approved: false, reason: 'policy-incremental-cost-bounds-missing' };
  const outputCost = upperTokenCost(cost.outputTokens, cost.outputPricePerMillion);
  const restoreCost = upperTokenCost(cost.restoreTokens, Math.max(cost.input.upper, cost.cacheRead.upper, cost.cacheWrite.upper));
  const extraCostUpperUsd = roundUp(roundUp(cost.overheadUsd + outputCost) + restoreCost);
  const certificate: Certificate = {
    requestHash, model: input.model, protocol: input.protocol,
    expiresAt: new Date(now + 60_000).toISOString(),
    beforeLowerTokens: tokensForBytes(beforeBytes, cost.bytesPerTokenUpper, false),
    afterUpperTokens: tokensForBytes(afterBytes, cost.bytesPerTokenLower, true),
    oldMinPricePerMillion: Math.min(cost.input.lower, cost.cacheRead.lower, cost.cacheWrite.lower),
    newMaxPricePerMillion: Math.max(cost.input.upper, cost.cacheRead.upper, cost.cacheWrite.upper),
    extraCostUpperUsd,
    incremental: cost.incremental,
    assumptions: [
      `For both complete serialized requests: bytes/${cost.bytesPerTokenUpper} <= billed input tokens <= bytes/${cost.bytesPerTokenLower}. This is a configured assumption, not an actual tokenizer.`,
      'Configured price bounds cover all applicable billing tiers and cache behavior.',
      'The entire baseline may use the cheapest cache/input price; the entire folded request may use the most expensive input/cache-write price. No unchanged-prefix cancellation is assumed.',
      'The comparison covers the next complete input and all extra work caused by folding relative to completing the same task without folding. Incremental bounds include extra tool calls, direct fees, model round trips, complete resent history/tool-result inputs and generated outputs. No future savings are credited; already billed output is a sunk cost.',
      'Incremental token and tool-fee bounds are aggregate totals, not per-call rates. Counts describe additional work, not a universal tool price. Legacy overhead/output/restoration reserves are additional, disjoint costs.',
    ],
  };
  return proveSavings({ ...proofInput, certificate });
}
