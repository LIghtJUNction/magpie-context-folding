import { open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { policySchema, scriptSchema } from './policy.js';
import { modeOptions, modeSchema, modes } from './modes.js';
import type { Strategy } from './modes.js';

const policyCost = policySchema.shape.cost.unwrap();
const scriptTomlSchema = z.object({
  command: scriptSchema.shape.command,
  timeout_ms: scriptSchema.shape.timeoutMs,
  max_output_bytes: scriptSchema.shape.maxOutputBytes,
  max_input_bytes: scriptSchema.shape.maxInputBytes,
  max_summary_chars: scriptSchema.shape.maxSummaryChars,
}).strict();
const costTomlSchema = z.object({
  bytes_per_token_lower: policyCost.shape.bytesPerTokenLower,
  bytes_per_token_upper: policyCost.shape.bytesPerTokenUpper,
  input: policyCost.shape.input,
  cache_read: policyCost.shape.cacheRead,
  cache_write: policyCost.shape.cacheWrite,
  output_price_per_million: policyCost.shape.outputPricePerMillion,
  overhead_usd: policyCost.shape.overheadUsd,
  output_tokens: policyCost.shape.outputTokens,
  restore_tokens: policyCost.shape.restoreTokens,
  incremental: z.object({
    tool_calls: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    model_round_trips: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    input_tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    output_tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    input_price_per_million: z.number().finite().nonnegative(),
    output_price_per_million: z.number().finite().nonnegative(),
    tool_fees_usd: z.number().finite().nonnegative(),
  }).strict().optional(),
}).strict();
const policyTomlSchema = z.object({
  mode: policySchema.shape.mode,
  auto_roles: policySchema.shape.autoRoles,
  min_chars: policySchema.shape.minChars,
  summary_chars: policySchema.shape.summaryChars,
  minimum_saving_usd: policySchema.shape.minimumSavingUsd,
  cost: costTomlSchema.optional(),
  script: scriptTomlSchema.optional(),
  certificate_script: scriptTomlSchema.optional(),
}).strict();
const policyLayerSchema = policyTomlSchema.partial().extend({
  cost: costTomlSchema.partial().extend({
    input: z.object(policyCost.shape.input.shape).strict().partial().optional(),
    cache_read: z.object(policyCost.shape.cacheRead.shape).strict().partial().optional(),
    cache_write: z.object(policyCost.shape.cacheWrite.shape).strict().partial().optional(),
    incremental: costTomlSchema.shape.incremental.unwrap().partial().optional(),
  }).optional(),
  script: scriptTomlSchema.partial().optional(),
  certificate_script: scriptTomlSchema.partial().optional(),
});
const policyOptionsLayerSchema = policySchema.partial().extend({
  cost: z.object(policyCost.shape).strict().partial().extend({
    input: z.object(policyCost.shape.input.shape).strict().partial().optional(),
    cacheRead: z.object(policyCost.shape.cacheRead.shape).strict().partial().optional(),
    cacheWrite: z.object(policyCost.shape.cacheWrite.shape).strict().partial().optional(),
    incremental: policyCost.shape.incremental.unwrap().partial().optional(),
  }).optional(),
  script: scriptSchema.partial().optional(),
  certificateScript: scriptSchema.partial().optional(),
});

function renameKeys(value: unknown, camel: boolean): unknown {
  if (Array.isArray(value)) return value.map(item => renameKeys(item, camel));
  if (!table(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    camel ? key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
      : key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`),
    renameKeys(item, camel),
  ]));
}

const httpUrl = z.string().refine(value => {
  if (/[\s\x00-\x1f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname);
  } catch { return false; }
});
const accountingSchema = z.object({
  url: httpUrl,
  timeoutMs: z.number().int().min(50).max(10_000).default(500),
}).strict();

export const optionsSchema = z.object({
  mode: modeSchema.default('intelligence'),
  enabled: z.boolean().default(true),
  thresholdTokens: z.number().int().positive().default(modes.intelligence.thresholdTokens),
  keepRecentMessages: z.number().int().min(0).default(modes.intelligence.keepRecentMessages),
  headChars: z.number().int().min(0).max(1000).default(modes.intelligence.headChars),
  maxSessionBytes: z.number().int().positive().max(64 * 1024 * 1024).default(64 * 1024 * 1024),
  minimumSavingUsd: z.number().finite().nonnegative().default(0.000001),
  gatewayTimeoutMs: z.number().int().min(100).max(10_000).optional(),
  accounting: accountingSchema.optional(),
  recoveryToolName: z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/).optional(),
  policy: policySchema.default(() => policySchema.parse(modeOptions('intelligence').policy)),
}).strict();

export type Options = z.infer<typeof optionsSchema>;
export function parseOptions(value: unknown): Options {
  const input = value ?? {};
  const layer = explicitFields(optionsSchema.partial().extend({
    accounting: accountingSchema.partial().optional(), policy: policyOptionsLayerSchema.optional(),
  }).parse(input), input);
  const preset = modeOptions(layer.mode ?? 'intelligence');
  const result = { ...preset, ...layer, policy: { ...preset.policy, ...layer.policy,
    mode: layer.policy?.mode ?? (layer.accounting || layer.policy?.cost || layer.policy?.certificateScript ? 'cost' : 'bytes'),
  } };
  return optionsSchema.parse(result);
}

const foldingSchema = z.object({
  mode: optionsSchema.shape.mode,
  enabled: optionsSchema.shape.enabled,
  threshold_tokens: optionsSchema.shape.thresholdTokens,
  keep_recent_messages: optionsSchema.shape.keepRecentMessages,
  head_chars: optionsSchema.shape.headChars,
  max_session_bytes: optionsSchema.shape.maxSessionBytes,
  minimum_saving_usd: optionsSchema.shape.minimumSavingUsd,
}).strict();
const annotationsSchema = z.object({
  enabled: z.boolean().default(true),
  default_fold: z.boolean().default(true),
  keep: z.array(z.string().min(1).refine(value => !value.includes('\0'))).default([]),
}).strict();
const gcSchema = z.object({
  enabled: z.boolean().default(false),
  strength: z.enum(['off', 'conservative', 'balanced', 'aggressive']).default('conservative'),
  idle_seconds: z.number().finite().min(0).max(315_576_000).default(2_592_000),
  max_uses: z.number().int().min(0).max(1_000_000_000).default(2),
  retention_seconds: z.number().finite().min(0).max(315_576_000).default(2_592_000),
  auto_purge: z.boolean().default(false),
}).strict();
const tomlAccountingSchema = z.object({
  url: httpUrl,
  timeout_ms: accountingSchema.shape.timeoutMs,
}).strict();
const magpieSchema = z.object({
  recovery_tool_name: optionsSchema.shape.recoveryToolName,
  gateway_timeout_ms: optionsSchema.shape.gatewayTimeoutMs,
  accounting: tomlAccountingSchema.optional(),
}).strict();
const configSchema = z.object({
  folding: foldingSchema.default(() => foldingSchema.parse({})),
  annotations: annotationsSchema.default(() => annotationsSchema.parse({})),
  gc: gcSchema.default(() => gcSchema.parse({})),
  magpie: magpieSchema.default({}),
  policy: policyTomlSchema.default(() => policyTomlSchema.parse({})),
}).strict();
const layerSchema = z.object({
  version: z.literal(1).optional(),
  folding: foldingSchema.partial().optional(),
  annotations: annotationsSchema.partial().optional(),
  gc: gcSchema.partial().optional(),
  policy: policyLayerSchema.optional(),
  magpie: z.object({
    recovery_tool_name: optionsSchema.shape.recoveryToolName,
    gateway_timeout_ms: optionsSchema.shape.gatewayTimeoutMs,
    accounting: tomlAccountingSchema.partial().optional(),
  }).strict().optional(),
}).strict();

export type Config = z.infer<typeof configSchema>;
export class ConfigError extends Error {
  constructor(readonly source: string, readonly field: string, reason: string) {
    super(`${source}: ${field}: ${reason}`);
    this.name = 'ConfigError';
  }
}

const MAX_CONFIG_BYTES = 1024 * 1024;
type Table = Record<string, unknown>;
const table = (value: unknown): value is Table => value !== null && typeof value === 'object' && !Array.isArray(value);
const missing = (error: unknown) => table(error) && error.code === 'ENOENT';

function validated<T extends z.ZodType>(schema: T, value: unknown, source: string): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    // Parser/Zod messages may contain secret values. Report paths and fixed text only.
    const path = [...issue.path];
    if (issue.code === 'unrecognized_keys') path.push('<unknown>');
    throw new ConfigError(source, path.join('.') || 'settings', 'invalid or unknown setting');
  }
  return result.data;
}

export function globalConfigPath(): string {
  return join(process.env.XDG_CONFIG_HOME || join(process.env.HOME || homedir(), '.config'), 'context-folding', 'config.toml');
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch (error) {
    if (missing(error)) return false;
    throw new ConfigError(path, 'file', 'cannot inspect path');
  }
}

export async function projectConfigPath(cwd = process.cwd()): Promise<string | null> {
  let directory = resolve(cwd);
  try {
    if (!(await stat(directory)).isDirectory()) throw new Error();
  } catch { throw new ConfigError(directory, 'project_dir', 'expected an accessible directory'); }
  while (true) {
    const candidate = join(directory, '.context-folding.toml');
    if (await exists(candidate)) return candidate;
    if (await exists(join(directory, '.git')) || dirname(directory) === directory) return null;
    directory = dirname(directory);
  }
}

async function readConfig(path: string): Promise<unknown | undefined> {
  let handle;
  try { handle = await open(path, 'r'); }
  catch (error) {
    if (missing(error)) return undefined;
    throw new ConfigError(path, 'file', 'cannot read settings');
  }
  try {
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_CONFIG_BYTES) throw new ConfigError(path, 'file', 'settings exceed 1048576 bytes');
    try {
      return Bun.TOML.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)));
    } catch { throw new ConfigError(path, 'TOML', 'invalid settings'); }
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(path, 'file', 'cannot read settings');
  } finally { await handle.close(); }
}

function merge(base: Table, update: Table): void {
  for (const [key, value] of Object.entries(update)) {
    if (value === undefined || key === 'version') continue;
    if (table(value) && table(base[key])) merge(base[key], value);
    else base[key] = structuredClone(value);
  }
}

// Zod's partial() still applies inner defaults. A layer may contribute only
// fields actually present in that source; final defaults belong to configSchema.
function explicitFields<T>(parsed: T, input: unknown): T {
  if (table(parsed) && table(input)) {
    for (const key of Object.keys(parsed)) {
      if (!Object.hasOwn(input, key) || input[key] === undefined) delete parsed[key];
      else explicitFields(parsed[key], input[key]);
    }
  }
  return parsed;
}

function apply(base: Table, input: unknown, source: string): void {
  const layer = explicitFields(validated(layerSchema, input, source), input);
  merge(base, layer);
}

function fromOptions(input: unknown): Table {
  const parsed = explicitFields(validated(optionsSchema.partial().extend({
    accounting: accountingSchema.partial().optional(), policy: policyOptionsLayerSchema.optional(),
  }), input ?? {}, '<overrides>'), input ?? {});
  const { mode, enabled, thresholdTokens, keepRecentMessages, headChars, maxSessionBytes, minimumSavingUsd,
    gatewayTimeoutMs, accounting, recoveryToolName, policy } = parsed;
  return {
    ...(policy ? { policy: renameKeys(policy, false) } : {}),
    folding: { mode, enabled, threshold_tokens: thresholdTokens, keep_recent_messages: keepRecentMessages,
      head_chars: headChars, max_session_bytes: maxSessionBytes, minimum_saving_usd: minimumSavingUsd },
    magpie: { recovery_tool_name: recoveryToolName, gateway_timeout_ms: gatewayTimeoutMs,
      ...(accounting ? { accounting: { url: accounting.url, timeout_ms: accounting.timeoutMs } } : {}) },
  };
}

async function effectiveConfig(cwd: string | undefined, overrides: unknown, agenticMode?: Strategy) {
  let config: Table = {};
  let explicitPolicyMinimum = false;
  const recordPolicyMinimum = (data: unknown) => {
    if (table(data) && table(data.policy) && data.policy.minimum_saving_usd !== undefined) explicitPolicyMinimum = true;
  };
  const global = globalConfigPath();
  const sources: { global: string; project: string | null } = { global, project: null };
  let accountingSource = '<overrides>';
  let policySource = '<overrides>';
  const globalData = await readConfig(global);
  if (globalData !== undefined) {
    apply(config, globalData, global);
    recordPolicyMinimum(globalData);
    if (table(globalData) && globalData.policy !== undefined) policySource = global;
    if (table(globalData) && table(globalData.magpie) && globalData.magpie.accounting !== undefined) accountingSource = global;
  }
  sources.project = await projectConfigPath(cwd);
  if (sources.project) {
    const projectData = await readConfig(sources.project);
    if (projectData !== undefined) {
      apply(config, projectData, sources.project);
      recordPolicyMinimum(projectData);
      if (table(projectData) && projectData.policy !== undefined) policySource = sources.project;
      if (table(projectData) && table(projectData.magpie) && projectData.magpie.accounting !== undefined) accountingSource = sources.project;
    }
  }
  if (overrides !== undefined) {
    apply(config, overrides, '<overrides>');
    recordPolicyMinimum(overrides);
    if (table(overrides) && overrides.policy !== undefined) policySource = '<overrides>';
    if (table(overrides) && table(overrides.magpie) && overrides.magpie.accounting !== undefined) accountingSource = '<overrides>';
  }
  const explicit = config;
  const selectedMode = modeSchema.parse(table(explicit.folding) ? explicit.folding.mode ?? 'intelligence' : 'intelligence');
  const { policy: presetPolicy, ...presetFolding } = modeOptions(selectedMode, agenticMode);
  config = configSchema.parse({ folding: renameKeys(presetFolding, false), policy: renameKeys(presetPolicy, false) });
  merge(config, explicit);
  const explicitPolicy = table(explicit.policy) ? explicit.policy : {};
  if (explicitPolicy.mode === undefined && table(config.policy)
    && ((table(explicit.magpie) && explicit.magpie.accounting) || explicitPolicy.cost || explicitPolicy.certificate_script)) {
    config.policy.mode = 'cost';
  }
  if (!explicitPolicyMinimum && table(config.policy) && table(config.folding)) {
    config.policy.minimum_saving_usd = config.folding.minimum_saving_usd;
  }
  config.policy = validated(policyTomlSchema, config.policy, policySource);
  const result = validated(configSchema, config, accountingSource);
  validated(policySchema, renameKeys(result.policy, true), policySource);
  return { config: result, sources };
}

/** Effective TOML settings for CLI diagnostics; accounting URLs never leave this API. */
export async function loadConfig(cwd?: string, overrides?: unknown) {
  const result = await effectiveConfig(cwd, overrides);
  if (result.config.magpie.accounting) result.config.magpie.accounting.url = '[redacted]';
  for (const script of [result.config.policy.script, result.config.policy.certificate_script]) {
    if (script) script.command = ['/redacted'];
  }
  return result;
}

/** Load file defaults and then merge the existing camelCase plugin options. */
export async function loadOptions(explicit?: unknown, cwd?: string, agenticMode?: Strategy): Promise<Options> {
  const { config } = await effectiveConfig(cwd, fromOptions(explicit), agenticMode);
  const f = config.folding;
  const m = config.magpie;
  return validated(optionsSchema, {
    mode: f.mode, enabled: f.enabled, thresholdTokens: f.threshold_tokens,
    keepRecentMessages: f.keep_recent_messages,
    headChars: f.head_chars, maxSessionBytes: f.max_session_bytes, minimumSavingUsd: f.minimum_saving_usd,
    recoveryToolName: m.recovery_tool_name, gatewayTimeoutMs: m.gateway_timeout_ms, policy: renameKeys(config.policy, true),
    ...(m.accounting ? { accounting: { url: m.accounting.url, timeoutMs: m.accounting.timeout_ms } } : {}),
  }, '<effective settings>');
}
