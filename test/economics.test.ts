import assert from "node:assert/strict";
import test from "node:test";
import { proveSavings, type Certificate } from "../src/economics.js";

const now = Date.parse("2026-10-26T00:00:00Z");

function certificate(overrides: Partial<Certificate> = {}): Certificate {
  return {
    requestHash: "example-request-sha256",
    model: "example/model",
    protocol: "openai",
    expiresAt: "2026-10-26T00:01:00Z",
    beforeLowerTokens: 100_000,
    afterUpperTokens: 7_000,
    oldMinPricePerMillion: 0.1,
    newMaxPricePerMillion: 1.25,
    extraCostUpperUsd: 0,
    assumptions: ["Whole rendered input is bounded; price bounds cover every billing tier."],
    ...overrides,
  };
}

function prove(value: unknown, minimumSavingUsd = 0) {
  return proveSavings({
    certificate: value,
    requestHash: "example-request-sha256",
    model: "example/model",
    protocol: "openai",
    minimumSavingUsd,
    now,
  });
}

function approximately(actual: number | undefined, expected: number) {
  assert.ok(actual !== undefined);
  assert.ok(Math.abs(actual - expected) <= 1e-12, `${actual} != ${expected}`);
}

test("proves savings even if the baseline is fully cached and the folded input is rewritten", () => {
  const result = prove(certificate());
  assert.equal(result.approved, true);
  assert.equal(result.reason, "proven");
  approximately(result.baselineLowerUsd, 0.01);
  approximately(result.foldedUpperUsd, 0.00875);
  approximately(result.savingLowerUsd, 0.00125);
  assert.deepEqual(result.assumptions, certificate().assumptions);
});

test("does not mistake fewer tokens for a cache-adjusted cost saving", () => {
  const result = prove(certificate({ afterUpperTokens: 60_000 }));
  assert.equal(result.approved, false);
  approximately(result.savingLowerUsd, -0.065);
});

test("rejects break-even and requires savings strictly above the configured minimum", () => {
  assert.equal(prove(certificate({ afterUpperTokens: 8_000 })).approved, false);
  assert.equal(prove(certificate(), 0.00125).approved, false);
  assert.equal(prove(certificate(), 0.001).approved, true);
});

test("charges extra overhead instead of hiding it in gross savings", () => {
  const result = prove(certificate({ extraCostUpperUsd: 0.002 }));
  assert.equal(result.approved, false);
  approximately(result.foldedUpperUsd, 0.01075);
  approximately(result.savingLowerUsd, -0.00075);
});

test("fails closed for missing, malformed, negative, fractional, and non-finite bounds", () => {
  const invalidValues: unknown[] = [
    undefined,
    null,
    {},
    certificate({ beforeLowerTokens: -1 }),
    certificate({ afterUpperTokens: 0.5 }),
    certificate({ beforeLowerTokens: Number.MAX_SAFE_INTEGER + 1 }),
    certificate({ oldMinPricePerMillion: -0.1 }),
    certificate({ oldMinPricePerMillion: Number.NaN }),
    certificate({ newMaxPricePerMillion: Number.POSITIVE_INFINITY }),
    certificate({ extraCostUpperUsd: -1 }),
    certificate({ expiresAt: "not-a-date" }),
    { ...certificate(), newMaxPricePerMillion: undefined },
    { ...certificate(), oldMinPricePerMillion: "0.1" },
  ];
  for (const value of invalidValues) {
    assert.deepEqual(prove(value), { approved: false, reason: "invalid-certificate" });
  }
});

test("rejects stale or mismatched certificates", () => {
  assert.equal(prove(certificate({ requestHash: "another-request" })).reason, "certificate-request-mismatch");
  assert.equal(prove(certificate({ model: "another-model" })).reason, "certificate-model-mismatch");
  assert.equal(prove(certificate({ protocol: "anthropic" })).reason, "certificate-protocol-mismatch");
  assert.equal(prove(certificate({ expiresAt: "2026-10-26T00:00:00Z" })).reason, "certificate-expired");
  assert.equal(prove(certificate({ expiresAt: "2026-10-25T23:59:59Z" })).reason, "certificate-expired");
});

test("handles zero cache prices and invalid comparison settings conservatively", () => {
  assert.equal(prove(certificate({ oldMinPricePerMillion: 0 })).approved, false);
  for (const minimum of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(prove(certificate(), minimum).reason, "invalid-proof-settings");
  }
  assert.equal(proveSavings({
    certificate: certificate(),
    requestHash: "example-request-sha256",
    model: "example/model",
    protocol: "openai",
    minimumSavingUsd: 0,
    now: Number.NaN,
  }).reason, "invalid-proof-settings");
});

test("does not admit decimal break-even because of floating-point cancellation", () => {
  const exactBreakEven = certificate({
    beforeLowerTokens: 100_000,
    afterUpperTokens: 1_000,
    oldMinPricePerMillion: 0.1,
    newMaxPricePerMillion: 0.1,
    extraCostUpperUsd: 0.0099,
  });
  assert.equal(prove(exactBreakEven).approved, false);
  assert.equal(prove(exactBreakEven).savingLowerUsd, 0);
});

test("keeps extremely small values and overflowing monetary bounds fail-closed", () => {
  assert.equal(prove(certificate({
    oldMinPricePerMillion: Number.MIN_VALUE,
    newMaxPricePerMillion: 0,
    afterUpperTokens: 0,
  })).approved, false);
  assert.equal(prove(certificate({
    beforeLowerTokens: Number.MAX_SAFE_INTEGER,
    oldMinPricePerMillion: Number.MAX_VALUE,
  })).reason, "non-finite-cost-bounds");
});

test("savings are monotone in token bounds, prices, and overhead", () => {
  const baseline = prove(certificate()).savingLowerUsd;
  assert.ok(baseline !== undefined);
  const cheaper = prove(certificate({ afterUpperTokens: 6_000 })).savingLowerUsd;
  const pricier = prove(certificate({ newMaxPricePerMillion: 2 })).savingLowerUsd;
  const overhead = prove(certificate({ extraCostUpperUsd: 0.001 })).savingLowerUsd;
  const betterCachePrice = prove(certificate({ oldMinPricePerMillion: 0.2 })).savingLowerUsd;
  assert.ok(cheaper !== undefined && cheaper >= baseline);
  assert.ok(pricier !== undefined && pricier <= baseline);
  assert.ok(overhead !== undefined && overhead <= baseline);
  assert.ok(betterCachePrice !== undefined && betterCachePrice >= baseline);
});
