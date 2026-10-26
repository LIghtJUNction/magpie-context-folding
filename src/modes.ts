import { z } from 'zod';

export const strategySchema = z.enum(['intelligence', 'balanced', 'economy']);
export type Strategy = z.infer<typeof strategySchema>;
export const modeSchema = z.enum(['intelligence', 'balanced', 'economy', 'agentic']);
export type FoldingMode = z.infer<typeof modeSchema>;

export const modes = {
  intelligence: { thresholdTokens: 64_000, keepRecentMessages: 12, headChars: 400,
    autoRoles: ['tool'], minChars: 12_000, summaryChars: 1600 },
  balanced: { thresholdTokens: 32_000, keepRecentMessages: 6, headChars: 160,
    autoRoles: ['tool'], minChars: 4096, summaryChars: 800 },
  economy: { thresholdTokens: 8192, keepRecentMessages: 2, headChars: 0,
    autoRoles: ['assistant', 'tool'], minChars: 2048, summaryChars: 320 },
} as const;

export function modeOptions(mode: FoldingMode, agenticMode: Strategy = 'intelligence') {
  const preset = modes[mode === 'agentic' ? agenticMode : mode];
  return {
    mode, thresholdTokens: preset.thresholdTokens,
    keepRecentMessages: preset.keepRecentMessages, headChars: preset.headChars,
    policy: { mode: 'bytes' as const, autoRoles: [...preset.autoRoles],
      minChars: preset.minChars, summaryChars: preset.summaryChars },
  };
}
