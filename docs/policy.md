# Folding policy and conditional cost proof

A policy chooses eligible spans and decides whether one complete folded request is worth sending. It does not call a model, look up prices, mutate a request, or write an archive. Candidate selection and cost approval are separate steps: selecting a span never proves a saving.

## Modes and defaults

`policySchema.parse({})` produces `mode: "cost"`, `autoRoles: []`, `minChars: 4096`, and `minimumSavingUsd: 0`. Automatic selection is opt-in. With no configured cost bounds or certificate, cost mode rejects the proposed fold with `policy-cost-bounds-missing`.

- `cost`: requires a positive, conservative saving for this round, strictly above `minimumSavingUsd`.
- `bytes`: approves only when the UTF-8 byte count of the complete JSON-serialized `after` body is smaller than `before`. Its reason is `bytes-smaller-no-cost-proof`; it supplies no monetary proof. This is an explicit compatibility mode.

`autoRoles` may contain any unique subset of `user`, `assistant`, and `tool`. To opt into automatic folding of assistant text and tool results, use `["assistant", "tool"]`. `minChars` uses JavaScript UTF-16 string length, not tokens or UTF-8 bytes. The built-in selector provides a short archival label; it does not generate a semantic summary.

Recent-message protection and latest-user protection belong to the hook configuration. The hook must pass only spans that survive those protections, version protection, and existing user `keep` marks. The planner also excludes spans with `protectedReason`. Selecting the `user` role does not override hook protection. In particular, folding the newest assistant response requires the hook's recent-message settings to permit that span.

## Configuration and API

All policy keys are camelCase; unknown keys are rejected. This is a policy object passed to `policySchema`, `planCandidates`, or `evaluatePolicy`. Other configuration layers may wrap or translate this object.

```ts
import { evaluatePolicy, planCandidates, policySchema } from './src/policy.js';

const policy = policySchema.parse({
  mode: 'cost',
  autoRoles: ['assistant', 'tool'],
  minChars: 4096,
  minimumSavingUsd: 0,
  cost: {
    // Conditional bounds chosen for this example, not tokenizer guarantees.
    bytesPerTokenLower: 4,
    bytesPerTokenUpper: 4,
    // Synthetic USD per million tokens, not any model's prices.
    input: { lower: 1, upper: 1 },
    cacheRead: { lower: 0.1, upper: 0.1 },
    cacheWrite: { lower: 1.25, upper: 1.25 },
    overheadUsd: 0,
    outputTokens: 0,
    outputPricePerMillion: 0,
    restoreTokens: 0,
  },
});

// eligibleSpans must already have passed the hook's protections.
const { marks } = await planCandidates({
  policy, spans: eligibleSpans, model, protocol, signal,
});
// The caller archives originals and constructs the proposed complete body.
const proof = await evaluatePolicy({
  policy, model, protocol, before: originalBody, after: foldedBody, signal,
});
if (proof.approved) {
  // The caller may commit the proposed change after durable archival.
}
```

The module exports `policySchema`, `scriptSchema`, `planCandidates`, `evaluatePolicy`, `policyRequestHash`, and the types `Policy`, `PolicyInput`, `Script`, `PolicyRequest`, and `CandidateMark`. `protocol` is one of `chat`, `responses`, `anthropic`, or `gemini`.

Both functions are asynchronous. `planCandidates` returns `{ marks }` and throws on invalid configuration, script failure, or cancellation. `evaluatePolicy` returns a `SavingsProof` with `approved`, `reason`, and, for a valid cost comparison, conservative monetary bounds and assumptions. Invalid policy settings and certificate failures reject approval. Cancellation propagates to the caller. Callers should preserve the original request when planning or evaluation fails.

All prices and monetary amounts must be finite and nonnegative. Each price range requires `lower <= upper`. Token ratios must be finite, positive, and ordered. Token counts and `minChars` are nonnegative safe integers. The default token ratios, when `cost` is present, are `1` and `8`; all three price ranges are required. Incremental cost fields default to zero, which is valid only if zero actually bounds those incremental costs.

## What the calculation proves

Use complete bodies including system text, tools, provider fields, folding markers, summaries, the self-inclusive context budget, and the folding guide. The budget's UTF-8-bytes/4 estimate is a display estimate, never tokenizer or billing evidence. Model window capacity belongs to the host and current model, not plugin configuration; the plugin does not infer capacity or utilization. A guide newly added by folding belongs in `after`; do not add it to `before` merely to cancel its cost. Unchanged prefixes remain part of both complete requests because rewriting history may change cache eligibility.

Let `B0` and `B1` be `Buffer.byteLength(JSON.stringify(before))` and the equivalent for `after`. Under the caller's configured assumptions:

```text
beforeLowerTokens = floor(B0 / bytesPerTokenUpper)
afterUpperTokens  = ceil(B1 / bytesPerTokenLower)

oldMinPrice = min(input.lower, cacheRead.lower, cacheWrite.lower)
newMaxPrice = max(input.upper, cacheRead.upper, cacheWrite.upper)

baselineLowerUsd = beforeLowerTokens * oldMinPrice / 1,000,000
foldedUpperUsd   = afterUpperTokens * newMaxPrice / 1,000,000
                 + overheadUsd
                 + outputTokens * outputPricePerMillion / 1,000,000
                 + restoreTokens * input.upper / 1,000,000

approve only if baselineLowerUsd - foldedUpperUsd > minimumSavingUsd
```

The implementation rounds token bounds outward and uses the existing decimal proof verifier for monetary comparison. Break-even is rejected, including equality with the minimum saving. Overflow or unusable bounds do not approve a fold.

Byte/token bounds are conditional assumptions supplied by the user. They do not measure a tokenizer and are not universal guarantees. JSON bytes alone do not account for hidden provider formatting, multimodal billing, or all possible tokenization. Configure bounds that cover the actual billed requests, or supply a local certificate with defensible complete-request bounds. A returned proof is valid only under its stated assumptions.

The default price model permits the entire baseline to use the cheapest cache/input rate, and charges the entire folded request at the most expensive configured rate. It does not subtract an unchanged prefix or assume that a shorter request keeps its cache hit. If cache evidence justifies narrower bounds, supply a matching certificate rather than silently assuming cache continuity. Include every applicable billing tier in the bounds.

`overheadUsd`, `outputTokens`, and `restoreTokens` bound incremental costs of this comparison. The assistant response already generated and billed is a sunk cost: folding cannot refund that output charge. Do not count its original output cost as a new saving or charge it again as incremental output. The comparison concerns the next complete input request and extra work caused by folding. Include local-script costs in overhead if relevant. Output tokens mean extra output caused by the fold, including summary generation if used; no model-generated summary is performed by this implementation. Restoration tokens cover additional input needed to recover archived material for this round. If restoration can incur cache-write surcharges, also include those in overhead. Do not credit imagined savings over future turns or assume future restoration is free. If these incremental upper bounds are unknown, the configured conditional proof cannot establish real savings.

### A 10,000-token example

Take complete JSON-serialized bodies of 40,000 and 800 bytes and assume exactly 4 bytes per billed input token for this example. The resulting bounds are 10,000 tokens before and 200 after. These synthetic prices illustrate the calculation:

| Price category | Lower USD / million | Upper USD / million |
| --- | ---: | ---: |
| Input | 1.00 | 1.00 |
| Cache read | 0.10 | 0.10 |
| Cache write | 1.25 | 1.25 |

With no extra costs, the baseline lower bound is `$0.001`, the folded upper bound is `$0.00025`, and the saving lower bound is approximately `$0.00075`. A zero minimum permits the fold. A `$0.00075` minimum rejects it because the inequality is strict.

Add `$0.0001` fixed overhead, 100 incremental output tokens at `$2` per million, and 50 restoration tokens at `$1` per million. Extra cost becomes `$0.00035`, leaving approximately `$0.0004` saving. If the folded request instead has 5,000 tokens, its upper input cost is `$0.00625`, which exceeds the fully cached baseline even though its token count halved.

## Local candidate scripts

Scripts are opt-in trusted local programs. Configure an absolute executable followed by separate argv strings. No shell is invoked; shell metacharacters are passed literally. The policy runner does not provide a sandbox or restrict a program's filesystem/network capabilities. It makes no network or paid model call itself.

For example, save this as `/home/lightjunction/.config/magpie/select-folds.mjs`:

```js
let input = '';
for await (const chunk of process.stdin) input += chunk;
const context = JSON.parse(input);
if (context.version !== 1 || context.kind !== 'candidates') process.exit(2);
const marks = context.spans
  .filter(span => span.role === 'tool')
  .map(span => ({
    id: span.id,
    disposition: 'foldable',
    summary: 'Completed tool result archived; read the original for exact details.',
  }));
process.stdout.write(JSON.stringify({ marks }));
```

Configure the actual absolute Node executable on your machine:

```json
{
  "autoRoles": ["assistant", "tool"],
  "minChars": 4096,
  "script": {
    "command": ["/usr/bin/node", "/home/lightjunction/.config/magpie/select-folds.mjs"],
    "timeoutMs": 1000,
    "maxInputBytes": 8388608,
    "maxOutputBytes": 65536,
    "maxSummaryChars": 2000
  }
}
```

The runner writes one JSON context to stdin and closes it:

```json
{
  "version": 1,
  "kind": "candidates",
  "model": "configured/model",
  "protocol": "chat",
  "spans": [
    { "id": "supplied-id", "role": "tool", "text": "eligible original text", "messageIndex": 3 }
  ]
}
```

Only spans that pass the hook protections, `autoRoles`, `minChars`, and `protectedReason` are supplied. No script is run when that list is empty. The script writes exactly one JSON object to stdout:

```json
{
  "marks": [
    { "id": "supplied-id", "disposition": "foldable", "summary": "Completed result." }
  ]
}
```

`disposition` is `foldable` or `keep`. A foldable summary is optional; the hook must provide a fallback if omitted. A supplied summary is trimmed, must remain nonempty, and must fit `maxSummaryChars` UTF-16 characters. `keep` must omit the summary. Unknown keys, duplicate marks, unknown/protected/unsupplied IDs, arbitrary paths, and request mutation fields reject the entire result. A script may omit candidates. It can return at most one mark per supplied span. The planner itself never changes the request or archive.

Diagnostics may go to stderr, but stdout must contain only the result JSON. The combined stdout/stderr budget defaults to 65,536 bytes and is capped at 1,048,576. Input defaults to 8,388,608 bytes and is capped at 67,108,864. Timeout defaults to 1,000 ms and is capped at 60,000 ms. Summary length defaults to 2,000 and is capped at 16,384 UTF-16 characters. Timeout, cancellation, output overflow, invalid JSON, missing executable, and nonzero exit fail the operation. On POSIX, termination targets the script's process group; this does not sandbox programs that deliberately detach descendants.

## Local certificate scripts

An optional `certificateScript` uses the same command and resource-limit settings. It receives:

```text
{ version: 1, kind: "certificate", requestHash, model, protocol, before, after }
```

The hash is SHA-256 over UTF-8 `JSON.stringify({ model, protocol, before, after })`, in that key order. `policyRequestHash` supplies this exact serialization. It binds the certificate to both complete bodies; it is not a canonical JSON hash independent of key order.

The script returns a raw certificate, without a wrapper:

```text
{
  requestHash, model, protocol,
  expiresAt: "ISO timestamp with timezone",
  beforeLowerTokens: nonnegative safe integer,
  afterUpperTokens: nonnegative safe integer,
  oldMinPricePerMillion: finite nonnegative USD per million,
  newMaxPricePerMillion: finite nonnegative USD per million,
  extraCostUpperUsd: finite nonnegative USD,
  assumptions: ["How these bounds were established"]
}
```

A deterministic local tokenizer adapter can compute full rendered-request bounds using installed tokenizers and locally maintained prices. For instance, an adapter script can read stdin and return:

```js
// Implement this local module for your exact request rendering and billing rules.
import { boundCompleteRequestPair } from '/home/lightjunction/.config/magpie/local-bounds.mjs';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const context = JSON.parse(input);
if (context.version !== 1 || context.kind !== 'certificate') process.exit(2);
const bounds = await boundCompleteRequestPair(context);
process.stdout.write(JSON.stringify({
  ...bounds,
  requestHash: context.requestHash,
  model: context.model,
  protocol: context.protocol,
}));
```

`bounds` must supply expiration, both token bounds, both price bounds, total incremental cost, and assumptions. The adapter should use a deterministic observation time or local snapshot when reproducibility matters. Model-specific tokenizer code belongs in that adapter, not in the provider-neutral policy.

Certificate selection order is an explicit `evaluatePolicy({ certificate, ... })`, then `certificateScript`, then configured `cost`. An invalid explicit certificate or a failing certificate script does not fall back to a more permissive source. `proveSavings` checks structure, expiration, hash, model, protocol, monetary finiteness, and the strict minimum-saving inequality. Hash binding validates applicability, not the truth of supplied token, price, cache, or overhead claims; the configured local source remains responsible for those bounds. In bytes mode, no certificate is consulted.
