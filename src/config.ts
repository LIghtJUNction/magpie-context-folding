import { z } from 'zod';

export const optionsSchema = z.object({
  thresholdTokens: z.number().int().positive().default(32_000),
  keepRecentMessages: z.number().int().min(1).default(4),
  headChars: z.number().int().min(0).max(1000).default(160),
  maxSessionBytes: z.number().int().positive().max(64 * 1024 * 1024).default(64 * 1024 * 1024),
  minimumSavingUsd: z.number().finite().nonnegative().default(0.000001),
  gatewayTimeoutMs: z.number().int().min(100).max(10_000).optional(),
  accounting: z.object({
    url: z.url(),
    timeoutMs: z.number().int().min(50).max(10_000).default(500),
  }).optional(),
}).strict();

export type Options = z.infer<typeof optionsSchema>;
export const parseOptions = (value: unknown): Options => optionsSchema.parse(value ?? {});
