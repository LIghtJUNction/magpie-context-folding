import { Database } from 'bun:sqlite';
import { chmod, mkdir, open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { digest, stateDirectory, Store } from './store.js';
import { formatTokenCount } from './metrics.js';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const scopeSchema = z.string().regex(/^[a-f0-9]{64}$/);
const reasonSchema = z.enum(['annotated-regions-folded', 'annotation-grace-period', 'no-eligible-annotations', 'unrecognized']);
const statusSchema = z.enum(['pending', 'confirmed', 'failed', 'unverified']);
const observationSchema = z.object({
  requestId: z.string().uuid(), observedAt: count.max(8_640_000_000_000_000), status: statusSchema,
  completedAt: count.max(8_640_000_000_000_000).optional(),
  sessionKey: scopeSchema,
});
const decisionSchema = z.object({
  reason: reasonSchema.catch('unrecognized'),
  beforeBytes: count, afterBytes: count, foldedRegions: count, replayedReferences: count, waiting: count,
  observation: observationSchema,
});
const rowSchema = z.object({ scope: scopeSchema, decision: z.string().nullable(), archivedEntries: count });
const basis = 'json-utf8-bytes/4' as const;
type Decision = z.infer<typeof decisionSchema>;
type Row = { scope: string; archivedEntries: number; decision: Decision | null };

export interface RequestView {
  observedAt: number;
  completedAt?: number;
  status: z.infer<typeof statusSchema>;
  reason: z.infer<typeof reasonSchema>;
  foldedRegions: number;
  replayedReferences: number;
  waiting: number;
  beforeBytes: number;
  afterBytes: number;
  beforeTokensEstimated: number;
  afterTokensEstimated: number;
  estimatedTokenDelta: number;
  basis: typeof basis;
}
export type Visibility =
  | { selection: 'session'; request: RequestView | null }
  | { selection: 'unbound'; reason: 'missing-session' | 'unknown-session' | 'ambiguous-session' }
  | { selection: 'global-lifetime'; activeSessions: number; foldCount: number; successfulFoldedRequests: number;
      estimatedTokenDelta: string; basis: typeof basis };
export type VisibilitySelection = { scope?: string; client?: boolean; sessionId?: string };

/** Inspect decision metadata only; never decode original text or create an archive. */
async function rows(scope?: string): Promise<Row[]> {
  if (scope !== undefined) scopeSchema.parse(scope);
  const path = join(stateDirectory(), 'state.sqlite');
  try { await stat(path); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    return [];
  }
  const database = new Database(path, { readonly: true, strict: true });
  try {
    database.exec('PRAGMA busy_timeout = 2000');
    const query = 'SELECT scope, json_extract(snapshot, \'$.decision\') AS decision, '
      + 'COALESCE(json_array_length(snapshot, \'$.entries\'), 0) AS archivedEntries FROM sessions';
    const values = scope === undefined
      ? database.query(query + ' ORDER BY scope').all()
      : database.query(query + ' WHERE scope = ?').all(scope);
    return values.map(value => {
      const row = rowSchema.parse(value);
      const parsed = decisionSchema.safeParse(row.decision === null ? null : JSON.parse(row.decision));
      return { scope: row.scope, archivedEntries: row.archivedEntries, decision: parsed.success ? parsed.data : null };
    });
  } finally { database.close(); }
}

function view(decision: Decision | null): RequestView | null {
  if (!decision) return null;
  const { observedAt, completedAt, status } = decision.observation;
  const { reason, foldedRegions, replayedReferences, waiting, beforeBytes, afterBytes } = decision;
  const beforeTokensEstimated = Math.ceil(beforeBytes / 4);
  const afterTokensEstimated = Math.ceil(afterBytes / 4);
  return { observedAt, ...(completedAt === undefined ? {} : { completedAt }),
    status, reason, foldedRegions, replayedReferences, waiting, beforeBytes, afterBytes,
    beforeTokensEstimated, afterTokensEstimated, estimatedTokenDelta: beforeTokensEstimated - afterTokensEstimated, basis };
}

async function selected(selection: VisibilitySelection): Promise<Row | Extract<Visibility, { selection: 'unbound' }>> {
  if (selection.scope !== undefined) {
    const row = (await rows(selection.scope))[0];
    if (!row) throw new Error('Unknown context scope');
    return row;
  }
  if (!selection.sessionId) return { selection: 'unbound', reason: 'missing-session' };
  const sessionKey = digest(selection.sessionId);
  const matches = (await rows()).filter(row => row.decision?.observation.sessionKey === sessionKey);
  if (matches.length !== 1) return { selection: 'unbound', reason: matches.length ? 'ambiguous-session' : 'unknown-session' };
  return matches[0]!;
}

/** Explicit session enumeration is the only visibility output that includes recovery scopes. */
export async function visibleSessions() {
  return (await rows()).map(row => ({ scope: row.scope, archivedEntries: row.archivedEntries, request: view(row.decision) }))
    .sort((a, b) => (b.request?.observedAt ?? 0) - (a.request?.observedAt ?? 0) || a.scope.localeCompare(b.scope));
}

export async function visibility(selection: VisibilitySelection = {}): Promise<Visibility> {
  if (selection.scope !== undefined || selection.client) {
    const row = await selected(selection);
    return 'selection' in row ? row : { selection: 'session', request: view(row.decision) };
  }
  const data = await new Store().readStats();
  return { selection: 'global-lifetime', activeSessions: data.storage.activeSessions,
    foldCount: data.metrics.foldBatchesApproved, successfulFoldedRequests: data.metrics.successfulFoldedRequests,
    estimatedTokenDelta: data.metrics.estimatedTokenDelta, basis };
}

const statusLabels: Record<RequestView['status'], string> = {
  pending: '投影待确认', confirmed: '响应已匹配', failed: '请求失败', unverified: '响应未核实',
};
const signed = (value: number | string): string => `${BigInt(value) > 0n ? '+' : ''}${formatTokenCount(String(value))}`;

export function formatVisibility(data: Visibility): string {
  if (data.selection === 'global-lifetime') {
    return `CF 全局累计 · ${data.foldCount} 次折叠 · ${data.successfulFoldedRequests} 个成功折叠请求 · 净减少≈${signed(data.estimatedTokenDelta)} tok`;
  }
  if (data.selection === 'unbound') return 'CF 当前会话未绑定 · 使用 sessions 查找 scope，或让网关传递相同 session_id';
  const r = data.request;
  if (!r) return 'CF 当前会话 · 未记录请求对比（旧记录或尚未观察）';
  return `CF 当前会话最近记录 · 折叠 ${r.foldedRegions} 段 / 已有引用 ${r.replayedReferences} / 等待 ${r.waiting}`
    + ` · ≈${formatTokenCount(String(r.beforeTokensEstimated))} → ${formatTokenCount(String(r.afterTokensEstimated))} tok`
    + ` · 净减少≈${signed(r.estimatedTokenDelta)} · ${statusLabels[r.status]} · ${new Date(r.observedAt).toISOString()}`;
}

/** Statusline and hooks receive JSON on stdin. Never read arbitrary-size transcripts. */
export async function readClientInput(stream: AsyncIterable<Uint8Array | string>): Promise<{ sessionId?: string; event?: string }> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
    length += bytes.length;
    if (length > 1024 * 1024) throw new Error('Client input exceeds 1048576 bytes');
    chunks.push(bytes);
  }
  if (length === 0) return {};
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Invalid client JSON'); }
  const parsed = z.object({ session_id: z.string().min(1).max(4096).optional(), hook_event_name: z.string().max(100).optional() }).safeParse(value);
  if (!parsed.success) throw new Error('Invalid client JSON');
  return { ...(parsed.data.session_id === undefined ? {} : { sessionId: parsed.data.session_id }),
    ...(parsed.data.hook_event_name === undefined ? {} : { event: parsed.data.hook_event_name }) };
}

/** Notification state is separate from the archive and never enters model context. */
async function claimNotification(binding: string, decision: Decision): Promise<boolean> {
  const directory = join(stateDirectory(), 'ui');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'notifications.sqlite');
  const file = await open(path, 'a', 0o600);
  await file.close();
  await chmod(path, 0o600);
  const database = new Database(path, { create: true, strict: true });
  try {
    database.exec('PRAGMA busy_timeout = 2000');
    database.exec('CREATE TABLE IF NOT EXISTS notifications (binding TEXT PRIMARY KEY, request TEXT NOT NULL, observed_at INTEGER NOT NULL)');
    const { requestId, observedAt } = decision.observation;
    const result = database.query('INSERT INTO notifications(binding, request, observed_at) VALUES (?, ?, ?) '
      + 'ON CONFLICT(binding) DO UPDATE SET request = excluded.request, observed_at = excluded.observed_at '
      + 'WHERE notifications.request <> excluded.request AND notifications.observed_at <= excluded.observed_at RETURNING request')
      .get(binding, requestId, observedAt);
    return result !== null;
  } finally { database.close(); }
}

/** Stop notifications are opt-in and use systemMessage only, never additionalContext. */
export async function hookNotification(selection: VisibilitySelection, event?: string): Promise<{ systemMessage?: string }> {
  if (event !== 'Stop') return {};
  const row = await selected(selection);
  if ('selection' in row || !row.decision || row.decision.observation.status !== 'confirmed') return {};
  const d = row.decision;
  if (d.foldedRegions + d.replayedReferences === 0) return {};
  // A long generation can finish well after it was observed. Prefer completion
  // time, while retaining old-record compatibility. This only rejects stale
  // notifications; it does not establish a binding to the current client turn.
  const age = Date.now() - (d.observation.completedAt ?? d.observation.observedAt);
  if (age < 0 || age > 5 * 60_000) return {};
  const binding = digest(JSON.stringify([row.scope, selection.sessionId ?? 'explicit-scope']));
  if (!(await claimNotification(binding, d))) return {};
  return { systemMessage: formatVisibility({ selection: 'session', request: view(d) }) };
}
