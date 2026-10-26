import { z } from "zod";

const certificateSchema = z.object({
  requestHash: z.string().min(1),
  model: z.string().min(1),
  protocol: z.string().min(1),
  expiresAt: z.iso.datetime({ offset: true }),
  beforeLowerTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  afterUpperTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  oldMinPricePerMillion: z.number().nonnegative(),
  newMaxPricePerMillion: z.number().nonnegative(),
  extraCostUpperUsd: z.number().nonnegative(),
  assumptions: z.array(z.string()),
});

export type Certificate = z.infer<typeof certificateSchema>;

interface ProofInput {
  certificate: unknown;
  requestHash: string;
  model: string;
  protocol: string;
  minimumSavingUsd: number;
  now?: number;
}

export interface SavingsProof {
  approved: boolean;
  reason: string;
  baselineLowerUsd?: number;
  foldedUpperUsd?: number;
  savingLowerUsd?: number;
  assumptions?: string[];
  bounds?: Pick<Certificate, 'beforeLowerTokens' | 'afterUpperTokens' | 'oldMinPricePerMillion' | 'newMaxPricePerMillion' | 'extraCostUpperUsd' | 'expiresAt'>;
}

interface Decimal {
  coefficient: bigint;
  scale: number;
}

function decimal(value: number): Decimal {
  const [mantissa = "0", exponent = "0"] = value.toString().split("e");
  const [whole = "0", fraction = ""] = mantissa.split(".");
  const coefficient = BigInt(whole + fraction);
  const scale = fraction.length - Number(exponent);
  return scale < 0
    ? { coefficient: coefficient * 10n ** BigInt(-scale), scale: 0 }
    : { coefficient, scale };
}

function inputCost(tokens: number, rate: number): Decimal {
  const price = decimal(rate);
  return { coefficient: BigInt(tokens) * price.coefficient, scale: price.scale + 6 };
}

function atScale(value: Decimal, scale: number): bigint {
  return value.coefficient * 10n ** BigInt(scale - value.scale);
}

function conservativeNumber(
  coefficient: bigint,
  scale: number,
  direction: "down" | "up",
): number {
  if (coefficient === 0n) return 0;
  const value = Number(`${coefficient}e-${scale}`);
  if (!Number.isFinite(value)) return value;
  if (value === 0) return direction === "down" ? -Number.MIN_VALUE : Number.MIN_VALUE;
  const bytes = new DataView(new ArrayBuffer(8));
  bytes.setFloat64(0, value);
  const increment = (value > 0) === (direction === "up") ? 1n : -1n;
  bytes.setBigUint64(0, bytes.getBigUint64(0) + increment);
  return bytes.getFloat64(0);
}

export function proveSavings(input: ProofInput): SavingsProof {
  const now = input.now ?? Date.now();
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(input.minimumSavingUsd) ||
    input.minimumSavingUsd < 0
  ) {
    return { approved: false, reason: "invalid-proof-settings" };
  }

  const parsed = certificateSchema.safeParse(input.certificate);
  if (!parsed.success) return { approved: false, reason: "invalid-certificate" };
  const certificate = parsed.data;
  if (certificate.requestHash !== input.requestHash) {
    return { approved: false, reason: "certificate-request-mismatch" };
  }
  if (certificate.model !== input.model) {
    return { approved: false, reason: "certificate-model-mismatch" };
  }
  if (certificate.protocol !== input.protocol) {
    return { approved: false, reason: "certificate-protocol-mismatch" };
  }
  if (Date.parse(certificate.expiresAt) <= now) {
    return { approved: false, reason: "certificate-expired" };
  }

  const baseline = inputCost(certificate.beforeLowerTokens, certificate.oldMinPricePerMillion);
  const folded = inputCost(certificate.afterUpperTokens, certificate.newMaxPricePerMillion);
  const overhead = decimal(certificate.extraCostUpperUsd);
  const minimum = decimal(input.minimumSavingUsd);
  const scale = Math.max(baseline.scale, folded.scale, overhead.scale, minimum.scale);
  const baselineAmount = atScale(baseline, scale);
  const foldedAmount = atScale(folded, scale) + atScale(overhead, scale);
  const savingAmount = baselineAmount - foldedAmount;
  const baselineLowerUsd = Math.max(0, conservativeNumber(baselineAmount, scale, "down"));
  const foldedUpperUsd = conservativeNumber(foldedAmount, scale, "up");
  const savingLowerUsd = conservativeNumber(savingAmount, scale, "down");
  if (![baselineLowerUsd, foldedUpperUsd, savingLowerUsd].every(Number.isFinite)) {
    return { approved: false, reason: "non-finite-cost-bounds" };
  }

  const approved =
    savingAmount > atScale(minimum, scale) && savingLowerUsd > input.minimumSavingUsd;
  return {
    approved,
    reason: approved ? "proven" : "saving-not-proven",
    baselineLowerUsd,
    foldedUpperUsd,
    savingLowerUsd,
    assumptions: certificate.assumptions,
    bounds: {
      beforeLowerTokens: certificate.beforeLowerTokens,
      afterUpperTokens: certificate.afterUpperTokens,
      oldMinPricePerMillion: certificate.oldMinPricePerMillion,
      newMaxPricePerMillion: certificate.newMaxPricePerMillion,
      extraCostUpperUsd: certificate.extraCostUpperUsd,
      expiresAt: certificate.expiresAt,
    },
  };
}
