import { open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

const nonnegativeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const optionsSchema = z.object({
  enabled: z.boolean().default(true),
  observeOnly: z.boolean().default(false),
  maxSessionBytes: z.number().int().positive().max(64 * 1024 * 1024).default(64 * 1024 * 1024),
  delayRequests: nonnegativeInteger.default(0),
  minSavingsTokens: nonnegativeInteger.default(256),
  gatewayTimeoutMs: z.number().int().min(100).max(10_000).optional(),
  shellToolName: z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/).optional(),
  recoveryCommand: z.string().min(1).max(4096).refine(value => value.trim().length > 0 && !/[\0\r\n]/.test(value)).optional(),
}).strict();
export type Options = z.infer<typeof optionsSchema>;

const foldingSchema = z.object({
  enabled: optionsSchema.shape.enabled,
  observe_only: optionsSchema.shape.observeOnly,
  max_session_bytes: optionsSchema.shape.maxSessionBytes,
  delay_requests: optionsSchema.shape.delayRequests,
  min_savings_tokens: optionsSchema.shape.minSavingsTokens,
}).strict();
// These sections are shared with the source-file/Python integration.
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
const magpieSchema = z.object({
  shell_tool_name: optionsSchema.shape.shellToolName,
  recovery_command: optionsSchema.shape.recoveryCommand,
  gateway_timeout_ms: optionsSchema.shape.gatewayTimeoutMs,
}).strict();
const configSchema = z.object({
  folding: foldingSchema.default(() => foldingSchema.parse({})),
  annotations: annotationsSchema.default(() => annotationsSchema.parse({})),
  gc: gcSchema.default(() => gcSchema.parse({})),
  magpie: magpieSchema.default({}),
}).strict();
const layerSchema = z.object({
  version: z.literal(1).optional(),
  folding: foldingSchema.partial().optional(),
  annotations: annotationsSchema.partial().optional(),
  gc: gcSchema.partial().optional(),
  magpie: magpieSchema.partial().optional(),
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
const migrationReason = 'removed: folding now requires agent-authored @context-fold begin/end annotations; remove mode, threshold, policy and accounting settings';
const removedBudgetReason = 'removed: delete context-window, output-reserve and budget-hint settings; context budgets are not managed by this project';

/** Recognize removed public settings without echoing arbitrary input or secret values. */
function rejectLegacy(value: unknown, source: string, runtime = false): void {
  // @context-fold begin rejectLegacy-76c9704195
  if (!table(value)) return;
  if (runtime) {
    for (const key of ['contextWindowTokens', 'reserveOutputTokens', 'budgetHints']) {
      if (Object.hasOwn(value, key)) throw new ConfigError(source, key, removedBudgetReason);
    }
    if (Object.hasOwn(value, 'recoveryToolName')) {
      throw new ConfigError(source, 'recoveryToolName', 'removed: MCP recovery was removed; use shellToolName for a callable shell tool and recoveryCommand for the local CLI');
    }
    for (const key of ['mode', 'thresholdTokens', 'keepRecentMessages', 'headChars', 'minimumSavingUsd', 'policy', 'accounting']) {
      if (Object.hasOwn(value, key)) throw new ConfigError(source, key, migrationReason);
    }
    return;
  }
  if (Object.hasOwn(value, 'policy')) throw new ConfigError(source, 'policy', migrationReason);
  if (table(value.folding)) {
    for (const key of ['context_window_tokens', 'reserve_output_tokens', 'budget_hints']) {
      if (Object.hasOwn(value.folding, key)) throw new ConfigError(source, `folding.${key}`, removedBudgetReason);
    }
    for (const key of ['mode', 'threshold_tokens', 'keep_recent_messages', 'head_chars', 'minimum_saving_usd']) {
      if (Object.hasOwn(value.folding, key)) throw new ConfigError(source, `folding.${key}`, migrationReason);
    }
  }
  if (table(value.magpie) && Object.hasOwn(value.magpie, 'accounting')) {
    throw new ConfigError(source, 'magpie.accounting', migrationReason);
  }
  if (table(value.magpie) && Object.hasOwn(value.magpie, 'recovery_tool_name')) {
    throw new ConfigError(source, 'magpie.recovery_tool_name', 'removed: MCP recovery was removed; use magpie.shell_tool_name and magpie.recovery_command for the local CLI');
  }
  // @context-fold end rejectLegacy-76c9704195
}

function validated<T extends z.ZodType>(schema: T, value: unknown, source: string): z.infer<T> {
  // @context-fold begin validated-6a51de1f8d
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    const path = [...issue.path];
    if (issue.code === 'unrecognized_keys') path.push('<unknown>');
    throw new ConfigError(source, path.join('.') || 'settings', 'invalid or unknown setting');
  }
  return result.data;
  // @context-fold end validated-6a51de1f8d
}

export function parseOptions(value: unknown): Options {
  const input = value ?? {};
  rejectLegacy(input, '<options>', true);
  return validated(optionsSchema, input, '<options>');
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
  // @context-fold begin projectConfigPath-e5b3265de1
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
  // @context-fold end projectConfigPath-e5b3265de1
}

async function readConfig(path: string): Promise<unknown | undefined> {
  // @context-fold begin readConfig-e7fa292b70
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
  // @context-fold end readConfig-e7fa292b70
}

function merge(base: Table, update: Table): void {
  for (const [key, value] of Object.entries(update)) {
    if (value === undefined || key === 'version') continue;
    if (table(value) && table(base[key])) merge(base[key], value);
    else base[key] = structuredClone(value);
  }
}

// Partial schemas still apply inner defaults; each layer may contribute only explicit fields.
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
  rejectLegacy(input, source);
  merge(base, explicitFields(validated(layerSchema, input, source), input));
}

function fromOptions(input: unknown): Table {
  // @context-fold begin fromOptions-1a94c69f7b
  const value = input ?? {};
  rejectLegacy(value, '<overrides>', true);
  const { enabled, observeOnly, maxSessionBytes, delayRequests, minSavingsTokens,
    gatewayTimeoutMs, shellToolName, recoveryCommand } =
    explicitFields(validated(optionsSchema.partial(), value, '<overrides>'), value);
  return {
    folding: { enabled, observe_only: observeOnly, max_session_bytes: maxSessionBytes, delay_requests: delayRequests,
      min_savings_tokens: minSavingsTokens },
    magpie: { shell_tool_name: shellToolName, recovery_command: recoveryCommand, gateway_timeout_ms: gatewayTimeoutMs },
  };
  // @context-fold end fromOptions-1a94c69f7b
}

export async function loadConfig(cwd?: string, overrides?: unknown) {
  // @context-fold begin loadConfig-e6b8752772
  const config: Table = {};
  const global = globalConfigPath();
  const sources = { global, project: await projectConfigPath(cwd) };
  const globalData = await readConfig(global);
  if (globalData !== undefined) apply(config, globalData, global);
  if (sources.project) {
    const projectData = await readConfig(sources.project);
    if (projectData !== undefined) apply(config, projectData, sources.project);
  }
  if (overrides !== undefined) apply(config, overrides, '<overrides>');
  return { config: validated(configSchema, config, '<effective settings>'), sources };
  // @context-fold end loadConfig-e6b8752772
}

/** Merge global settings, nearest project settings, then explicit camelCase plugin options. */
export async function loadOptions(explicit?: unknown, cwd?: string): Promise<Options> {
  // @context-fold begin loadOptions-69cb98dd63
  const { config } = await loadConfig(cwd, fromOptions(explicit));
  const f = config.folding;
  const m = config.magpie;
  return validated(optionsSchema, {
    enabled: f.enabled, observeOnly: f.observe_only,
    maxSessionBytes: f.max_session_bytes, delayRequests: f.delay_requests,
    minSavingsTokens: f.min_savings_tokens,
    shellToolName: m.shell_tool_name, recoveryCommand: m.recovery_command, gatewayTimeoutMs: m.gateway_timeout_ms,
  }, '<effective settings>');
  // @context-fold end loadOptions-69cb98dd63
}
