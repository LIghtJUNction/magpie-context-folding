import { Database } from 'bun:sqlite';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { chmod, mkdir, open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { addMetrics, emptyMetrics, metricsSchema } from './metrics.js';
import type { Metrics } from './metrics.js';

const markSchema = z.discriminatedUnion('disposition', [
  z.object({ disposition: z.literal('unmarked') }),
  z.object({ disposition: z.literal('keep') }),
  z.object({ disposition: z.literal('foldable'), summary: z.string().trim().min(1).max(2000) }),
]);
const layerSchema = z.object({
  id: z.string().min(1).max(128), text: z.string(), previousId: z.string().min(1).max(128),
});
const versionSchema = z.object({
  series: z.string().min(1), number: z.number().int().positive(), kind: z.enum(['file', 'similar']),
  previousId: z.string().optional(), path: z.string().optional(), range: z.string().optional(),
  automatic: z.boolean().optional(), latest: z.boolean().optional(),
  observations: z.array(z.string().regex(/^[a-f0-9]{64}$/)).optional(),
});
const groupSchema = z.object({
  id: z.string().min(1), children: z.array(z.string()).min(2).max(100),
  summary: z.string().trim().min(1).max(2000), enabled: z.boolean(), folded: z.string().optional(),
  foldedMark: z.string().optional(),
});
const sourceRangeSchema = z.object({
  sourceId: z.string().min(1), sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  start: z.number().int().nonnegative(), end: z.number().int().positive(), offsetUnit: z.literal('utf16'),
});
const entrySchema = z.object({
  id: z.string().min(1), role: z.enum(['user', 'assistant', 'tool']), text: z.string(),
  mark: markSchema, folded: z.string().optional(), layers: z.array(layerSchema).default([]),
  version: versionSchema.optional(), manual: z.boolean().optional(),
  protectionReason: z.string().optional(),
  foldedMark: z.string().optional(),
  annotation: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), label: z.string(),
    nodeVersion: z.literal(3).optional(), parentId: z.string().min(1).nullable().optional(),
    sourceRanges: z.array(sourceRangeSchema).min(1).optional(),
    observedRanges: z.array(sourceRangeSchema).optional(),
    children: z.array(z.object({ id: z.string().min(1), start: z.number().int().nonnegative(),
      end: z.number().int().positive() })).optional(),
  }).optional(),
  occurrences: z.record(z.string(), z.object({
    firstSeen: z.number().int().nonnegative(), lastSeen: z.number().int().nonnegative(), folded: z.boolean().optional(),
  })).optional(),
});
const snapshotSchema = z.object({
  version: z.literal(1), entries: z.array(entrySchema), groups: z.array(groupSchema).optional(),
  cycle: z.number().int().nonnegative().optional(),
  requestHash: z.string().optional(),
  projectedHash: z.string().optional(),
  decision: z.record(z.string(), z.unknown()).default({}),
  metrics: metricsSchema.default(emptyMetrics),
});
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const storedLayerSchema = layerSchema.omit({ text: true }).extend({ textHash: hashSchema });
const storedEntrySchema = entrySchema.omit({ text: true, folded: true, layers: true }).extend({
  textHash: hashSchema, foldedHash: hashSchema.optional(), layers: z.array(storedLayerSchema),
});
const storedSnapshotSchema = snapshotSchema.omit({ entries: true }).extend({
  entries: z.array(storedEntrySchema),
  payloadBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  sessionLimitBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});
const sessionRowSchema = z.object({ revision: z.number().int().positive(), snapshot: z.string() });
const textRowSchema = z.object({ text: z.string() });
const numberRowSchema = z.object({ value: z.number().int().nonnegative() });
const metadataRowSchema = z.object({ value: z.string() });

export class ScopeConflictError extends Error {
  constructor() { super('Context scope changed concurrently; retry request'); }
}

function assertSameSession(current: unknown, original: { revision: number; rawSnapshot: string | null }): void {
  if (current === null) {
    if (original.rawSnapshot === null) return;
  } else {
    const session = sessionRowSchema.parse(current);
    if (session.revision === original.revision && session.snapshot === original.rawSnapshot) return;
  }
  throw new ScopeConflictError();
}

export type Entry = z.infer<typeof entrySchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Mark = z.infer<typeof markSchema>;
export type Layer = z.infer<typeof layerSchema>;
export type Group = z.infer<typeof groupSchema>;
export interface StatsReport {
  metrics: Metrics;
  storage: { activeSessions: number; blobs: number; databaseBytes: number };
}
export interface ObservationCompletion {
  requestId: string;
  status: 'confirmed' | 'failed' | 'unverified';
}
type StoredSnapshot = z.infer<typeof storedSnapshotSchema>;
type SessionQuotaPolicy = 'configure' | 'preserve' | 'enforce';
const defaultSessionLimitBytes = 64 * 1024 * 1024;

export const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

export function stateDirectory(): string {
  return process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR
    ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'magpie-context-folding');
}

function metricsDifference(before: Metrics, after: Metrics): Metrics {
  return metricsSchema.parse(Object.fromEntries(metricsSchema.keyof().options.map(key => {
    const previous = before[key];
    const current = after[key];
    if (typeof previous === 'number' && typeof current === 'number') return [key, current - previous];
    return [key, (BigInt(current) - BigInt(previous)).toString()];
  })));
}

function readLifetimeMetrics(database: Database): Metrics {
  const row: unknown = database.query("SELECT value FROM meta WHERE key = 'lifetime-metrics'").get();
  return row === null ? emptyMetrics() : metricsSchema.parse(JSON.parse(metadataRowSchema.parse(row).value));
}

function legacyPayloadBytes(database: Database, metadata: string): number {
  // @context-fold begin legacyPayloadBytes-963f724ad0
  const sizes = z.object({ adjustment: z.number().int(), missing: z.number().int().nonnegative() }).parse(database.query(`
    SELECT COALESCE(SUM(length(CAST(blobs.text AS BLOB)) - 70), 0) AS adjustment,
      COALESCE(SUM(CASE WHEN blobs.hash IS NULL THEN 1 ELSE 0 END), 0) AS missing
    FROM json_tree(?) AS value
    LEFT JOIN blobs ON blobs.hash = value.value
    WHERE value.key IN ('textHash', 'foldedHash') AND value.path LIKE '$.entries[%'
  `).get(metadata));
  if (sizes.missing > 0) throw new Error('Archive content is missing');
  // Each stored hash replaces a JSON string (66 bytes) and adds four bytes to its key.
  return Buffer.byteLength(metadata) + sizes.adjustment;
  // @context-fold end legacyPayloadBytes-963f724ad0
}

function validateLayers(snapshot: Snapshot): void {
  // @context-fold begin validateLayers-f7672102a2
  const entries = new Set<string>();
  for (const entry of snapshot.entries) {
    if (entries.has(entry.id)) throw new Error('Duplicate archive entry ID');
    entries.add(entry.id);
    const previous = new Set(['original']);
    for (const layer of entry.layers) {
      if (previous.has(layer.id)) throw new Error('Duplicate or reserved fold layer ID');
      if (!previous.has(layer.previousId)) throw new Error('Fold layer must reference original or an earlier layer');
      previous.add(layer.id);
    }
  }
  const byId = new Map(snapshot.entries.map(entry => [entry.id, entry]));
  const annotationParents = new Map<string, string>();
  for (const entry of snapshot.entries) {
    const annotation = entry.annotation;
    if (!annotation) continue;
    if (annotation.nodeVersion === 3 && (!/^[a-f0-9]{64}$/.test(entry.id)
      || digest(entry.text) !== annotation.sha256 || !annotation.sourceRanges?.length)) {
      throw new Error('Invalid archive node identity or content');
    }
    if (annotation.nodeVersion === 3 && annotation.sourceRanges!.reduce((sum, range) => sum + range.end - range.start, 0) !== entry.text.length) {
      throw new Error('Archive source ranges do not cover the original');
    }
    for (const source of [...(annotation.sourceRanges ?? []), ...(annotation.observedRanges ?? [])]) {
      if (source.end <= source.start) throw new Error('Invalid archive source range');
    }
    let previousEnd = 0;
    for (const edge of annotation.children ?? []) {
      const child = byId.get(edge.id);
      if (!child?.annotation || edge.start < previousEnd || edge.end <= edge.start || edge.end > entry.text.length
        || entry.text.slice(edge.start, edge.end) !== child.text || annotationParents.has(edge.id)) {
        throw new Error('Invalid annotation child range or parent');
      }
      if (child.annotation.nodeVersion === 3 && child.annotation.parentId !== entry.id) {
        throw new Error('Annotation parent relation mismatch');
      }
      annotationParents.set(edge.id, entry.id);
      previousEnd = edge.end;
    }
  }
  for (const entry of snapshot.entries) {
    if (entry.annotation?.nodeVersion === 3 && entry.annotation.parentId !== undefined
      && entry.annotation.parentId !== null && annotationParents.get(entry.id) !== entry.annotation.parentId) {
      throw new Error('Dangling annotation parent');
    }
  }
  const latestSeries = new Set<string>();
  for (const entry of snapshot.entries) {
    const version = entry.version;
    if (version?.latest) {
      if (latestSeries.has(version.series)) throw new Error('Multiple latest observations in one version series');
      latestSeries.add(version.series);
    }
    if (!version?.previousId) continue;
    const previous = byId.get(version.previousId)?.version;
    if (!previous || previous.series !== version.series || previous.number >= version.number) {
      throw new Error('Version must reference an earlier member of the same series');
    }
  }
  const nodes = new Set(entries);
  for (const group of snapshot.groups ?? []) {
    if (nodes.has(group.id)) throw new Error('Duplicate archive node ID');
    nodes.add(group.id);
  }
  const parents = new Map<string, string>(annotationParents);
  for (const group of snapshot.groups ?? []) {
    for (const child of group.children) {
      if (!nodes.has(child) || parents.has(child)) throw new Error('Unknown or multiply parented group member');
      parents.set(child, group.id);
    }
  }
  for (const id of parents.keys()) {
    const visited = new Set<string>();
    let current: string | undefined = id;
    while (current !== undefined) {
      if (visited.has(current)) throw new Error('Cyclic fold group');
      visited.add(current);
      current = parents.get(current);
    }
  }
  // @context-fold end validateLayers-f7672102a2
}

function encode(snapshot: Snapshot): { stored: StoredSnapshot; blobs: Map<string, string> } {
  // @context-fold begin encode-e38d4c8d08
  const blobs = new Map<string, string>();
  const archive = (text: string): string => {
    // JSON string encoding preserves lone UTF-16 surrogates that SQLite TEXT cannot encode directly.
    const encoded = JSON.stringify(text);
    const hash = digest(encoded);
    blobs.set(hash, encoded);
    return hash;
  };
  const entries = snapshot.entries.map(({ text, folded, layers, ...entry }) => ({
    ...entry,
    textHash: archive(text),
    ...(folded === undefined ? {} : { foldedHash: archive(folded) }),
    layers: layers.map(({ text: layerText, ...layer }) => ({ ...layer, textHash: archive(layerText) })),
  }));
  return { stored: { ...snapshot, entries }, blobs };
  // @context-fold end encode-e38d4c8d08
}

function decode(database: Database, stored: StoredSnapshot): Snapshot {
  // @context-fold begin decode-4ab4086d3c
  const texts = new Map<string, string>();
  const load = (hash: string): string => {
    const cached = texts.get(hash);
    if (cached !== undefined) return cached;
    const { text: encoded } = textRowSchema.parse(database.query('SELECT text FROM blobs WHERE hash = ?').get(hash));
    if (digest(encoded) !== hash) throw new Error('Archive content hash mismatch');
    const text = z.string().parse(JSON.parse(encoded));
    texts.set(hash, text);
    return text;
  };
  const entries = stored.entries.map(({ textHash, foldedHash, layers, ...entry }) => ({
    ...entry,
    text: load(textHash),
    ...(foldedHash === undefined ? {} : { folded: load(foldedHash) }),
    layers: layers.map(({ textHash: layerHash, ...layer }) => ({ ...layer, text: load(layerHash) })),
  }));
  const snapshot = snapshotSchema.parse({ ...stored, entries });
  validateLayers(snapshot);
  return snapshot;
  // @context-fold end decode-4ab4086d3c
}

export class Store {
  readonly directory: string;
  readonly maxTotalBytes: number;

  constructor(directory = stateDirectory(), options: { maxTotalBytes?: number } = {}) {
    this.directory = resolve(directory);
    this.maxTotalBytes = options.maxTotalBytes ?? 256 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxTotalBytes) || this.maxTotalBytes <= 0) {
      throw new Error('Invalid global archive size limit');
    }
  }

  private async database<T>(run: (database: Database) => T): Promise<T> {
    // @context-fold begin database-094f17a959
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, 'state.sqlite');
    const file = await open(path, 'a', 0o600);
    await file.close();
    await chmod(path, 0o600);
    const database = new Database(path, { create: true, strict: true });
    try {
      database.exec('PRAGMA busy_timeout = 2000');
      database.exec('PRAGMA foreign_keys = ON');
      database.exec('PRAGMA journal_mode = DELETE');
      database.exec('PRAGMA auto_vacuum = FULL');
      const pageSize = numberRowSchema.parse(database.query('SELECT page_size AS value FROM pragma_page_size').get()).value;
      const pageLimit = Math.floor(this.maxTotalBytes / pageSize);
      if (pageLimit < 1) throw new Error('Global archive limit is smaller than one SQLite page');
      database.exec(`PRAGMA max_page_count = ${pageLimit}`);
      database.exec(`
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (
          scope TEXT PRIMARY KEY, revision INTEGER NOT NULL, snapshot TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS blobs (hash TEXT PRIMARY KEY, text TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS refs (
          scope TEXT NOT NULL REFERENCES sessions(scope) ON DELETE CASCADE,
          hash TEXT NOT NULL REFERENCES blobs(hash), PRIMARY KEY (scope, hash)
        );
        CREATE INDEX IF NOT EXISTS refs_hash ON refs(hash);
      `);
      const pageCount = numberRowSchema.parse(database.query('SELECT page_count AS value FROM pragma_page_count').get()).value;
      if (pageCount * pageSize > this.maxTotalBytes) throw new Error('Global archive full; original request retained');
      return run(database);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'SQLITE_FULL') {
        throw new Error('Global archive full; original request retained', { cause: error });
      }
      throw error;
    } finally {
      database.close();
    }
    // @context-fold end database-094f17a959
  }

  async scopeFor(identity: string): Promise<string> {
    return this.database((database) => {
      database.query("INSERT OR IGNORE INTO meta (key, value) VALUES ('secret', ?)").run(randomBytes(32).toString('hex'));
      const row = z.object({ value: hashSchema }).parse(database.query("SELECT value FROM meta WHERE key = 'secret'").get());
      return createHmac('sha256', Buffer.from(row.value, 'hex')).update(identity).digest('hex');
    });
  }

  async readStats(scope?: string): Promise<StatsReport> {
    // @context-fold begin readStats-6c01d10458
    if (scope !== undefined) hashSchema.parse(scope);
    const path = join(this.directory, 'state.sqlite');
    let file;
    try { file = await stat(path); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      if (scope !== undefined) throw new Error('Unknown context scope');
      return { metrics: emptyMetrics(), storage: { activeSessions: 0, blobs: 0, databaseBytes: 0 } };
    }
    const database = new Database(path, { readonly: true, strict: true });
    try {
      database.exec('PRAGMA busy_timeout = 2000');
      database.exec('BEGIN');
      let metrics: Metrics;
      if (scope === undefined) metrics = readLifetimeMetrics(database);
      else {
        const row: unknown = database.query('SELECT revision, snapshot FROM sessions WHERE scope = ?').get(scope);
        if (row === null) throw new Error('Unknown context scope');
        // Metrics do not require decoding any archived text or fold layers.
        const session = sessionRowSchema.parse(row);
        metrics = storedSnapshotSchema.parse(JSON.parse(session.snapshot)).metrics;
      }
      const activeSessions = numberRowSchema.parse(database.query('SELECT COUNT(*) AS value FROM sessions').get()).value;
      const blobs = numberRowSchema.parse(database.query('SELECT COUNT(*) AS value FROM blobs').get()).value;
      database.exec('COMMIT');
      return { metrics, storage: { activeSessions, blobs, databaseBytes: file.size } };
    } catch (error) {
      if (database.inTransaction) database.exec('ROLLBACK');
      throw error;
    } finally { database.close(); }
    // @context-fold end readStats-6c01d10458
  }

  async recordMetrics(scope: string, delta: Partial<Metrics>, signal?: AbortSignal, completion?: ObservationCompletion): Promise<void> {
    // @context-fold begin recordMetrics-8a08af355b
    signal?.throwIfAborted();
    hashSchema.parse(scope);
    if (completion !== undefined) z.object({
      requestId: z.string().uuid(), status: z.enum(['confirmed', 'failed', 'unverified']),
    }).strict().parse(completion);
    const increment = addMetrics(emptyMetrics(), delta);
    try { await stat(join(this.directory, 'state.sqlite')); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new Error('Unknown context scope');
      throw error;
    }
    await this.database(database => {
      signal?.throwIfAborted();
      database.exec('BEGIN IMMEDIATE');
      try {
        const row: unknown = database.query('SELECT revision, snapshot FROM sessions WHERE scope = ?').get(scope);
        if (row === null) throw new Error('Unknown context scope');
        const session = sessionRowSchema.parse(row);
        const stored = storedSnapshotSchema.parse(JSON.parse(session.snapshot));
        const metrics = addMetrics(stored.metrics, increment);
        let decision = stored.decision;
        const observed = z.object({ requestId: z.string().uuid() }).safeParse(decision.observation);
        // A delayed response belongs to its own request. It may contribute to
        // lifetime counters, but must never confirm a newer projection.
        if (completion && observed.success && observed.data.requestId === completion.requestId) {
          decision = { ...decision, observation: { ...(decision.observation as Record<string, unknown>),
            status: completion.status, completedAt: Date.now() } };
        }
        if (JSON.stringify(metrics) === JSON.stringify(stored.metrics) && JSON.stringify(decision) === JSON.stringify(stored.decision)) {
          database.exec('COMMIT');
          return;
        }
        const { payloadBytes, sessionLimitBytes, ...base } = stored;
        const previousBytes = payloadBytes ?? legacyPayloadBytes(database, JSON.stringify(base));
        const nextBytes = previousBytes + Buffer.byteLength(JSON.stringify(metrics)) - Buffer.byteLength(JSON.stringify(stored.metrics))
          + Buffer.byteLength(JSON.stringify(decision)) - Buffer.byteLength(JSON.stringify(stored.decision));
        const limit = sessionLimitBytes ?? defaultSessionLimitBytes;
        if (nextBytes > limit) throw new Error('Session archive full; statistics not committed');
        database.query('UPDATE sessions SET revision = ?, snapshot = ? WHERE scope = ?')
          .run(session.revision + 1, JSON.stringify({ ...base, decision, metrics, payloadBytes: nextBytes, sessionLimitBytes: limit }), scope);
        const lifetime = addMetrics(readLifetimeMetrics(database), increment);
        database.query("INSERT INTO meta (key, value) VALUES ('lifetime-metrics', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .run(JSON.stringify(lifetime));
        // SQLite's per-connection max_page_count also bounds metadata-only writes.
        signal?.throwIfAborted();
        database.exec('COMMIT');
      } catch (error) {
        if (database.inTransaction) database.exec('ROLLBACK');
        throw error;
      }
    });
    // @context-fold end recordMetrics-8a08af355b
  }

  /** Query an existing archive without opening a writer, initializing tables or changing counters. */
  async inspect<T>(scope: string, run: (snapshot: Snapshot) => T): Promise<T> {
    hashSchema.parse(scope);
    const path = join(this.directory, 'state.sqlite');
    try { await stat(path); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new Error('Unknown context scope');
      throw error;
    }
    const database = new Database(path, { readonly: true, strict: true });
    try {
      database.exec('BEGIN');
      const row = database.query('SELECT revision, snapshot FROM sessions WHERE scope = ?').get(scope);
      if (row === null) throw new Error('Unknown context scope');
      const session = sessionRowSchema.parse(row);
      const snapshot = decode(database, storedSnapshotSchema.parse(JSON.parse(session.snapshot)));
      const result = run(snapshot);
      database.exec('COMMIT');
      return result;
    } catch (error) {
      if (database.inTransaction) database.exec('ROLLBACK');
      throw error;
    } finally { database.close(); }
  }

  async transaction<T>(
    scope: string,
    create: boolean,
    maxBytes: number,
    run: (snapshot: Snapshot) => Promise<T> | T,
    signal?: AbortSignal,
    quotaPolicy: SessionQuotaPolicy = 'configure',
  ): Promise<T> {
    // @context-fold begin transaction-52062fd795
    signal?.throwIfAborted();
    hashSchema.parse(scope);
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('Invalid session archive size limit');
    const original = await this.database((database) => {
      database.exec('BEGIN');
      try {
        const row: unknown = database.query('SELECT revision, snapshot FROM sessions WHERE scope = ?').get(scope);
        if (row === null) {
          if (!create) throw new Error('Unknown context scope');
          database.exec('COMMIT');
          return { revision: 0, rawSnapshot: null, sessionLimitBytes: undefined,
            snapshot: snapshotSchema.parse({ version: 1, entries: [], decision: {} }) };
        }
        const session = sessionRowSchema.parse(row);
        const stored = storedSnapshotSchema.parse(JSON.parse(session.snapshot));
        const snapshot = decode(database, stored);
        database.exec('COMMIT');
        return { revision: session.revision, rawSnapshot: session.snapshot,
          sessionLimitBytes: stored.sessionLimitBytes, snapshot };
      } catch (error) {
        if (database.inTransaction) database.exec('ROLLBACK');
        throw error;
      }
    });

    // Keep SQLite closed while an asynchronous caller prepares its projection.
    const before = JSON.stringify(original.snapshot);
    const previousMetrics = structuredClone(original.snapshot.metrics);
    signal?.throwIfAborted();
    const result = await run(original.snapshot);
    signal?.throwIfAborted();
    const snapshot = snapshotSchema.parse(original.snapshot);
    validateLayers(snapshot);
    const after = JSON.stringify(snapshot);
    const payloadBytes = Buffer.byteLength(after);
    // maxBytes is this operation's ceiling. Only the configured request may change
    // the persisted quota; recovery tools preserve it.
    const sessionLimitBytes = quotaPolicy === 'configure' ? maxBytes
      : original.sessionLimitBytes ?? defaultSessionLimitBytes;
    const operationLimit = quotaPolicy === 'enforce' ? Math.min(maxBytes, sessionLimitBytes) : maxBytes;
    // Schema defaults and lowered limits must not block recovery. Existing snapshots
    // may stay the same size or shrink while over quota; only growth is rejected.
    const allowedBytes = original.revision > 0 ? Math.max(operationLimit, Buffer.byteLength(before)) : operationLimit;
    if (payloadBytes > allowedBytes) throw new Error('Session archive full; original request retained');
    const quotaChanged = quotaPolicy === 'configure' && original.sessionLimitBytes !== sessionLimitBytes;
    if (original.revision > 0 && before === after && !quotaChanged) {
      await this.database(database => {
        signal?.throwIfAborted();
        assertSameSession(database.query('SELECT revision, snapshot FROM sessions WHERE scope = ?').get(scope), original);
      });
      return result;
    }
    const { stored, blobs } = encode(snapshot);
    const serialized = JSON.stringify({ ...stored, payloadBytes, sessionLimitBytes });
    const metricsDelta = metricsDifference(previousMetrics, snapshot.metrics);
    const metricsChanged = JSON.stringify(previousMetrics) !== JSON.stringify(snapshot.metrics);

    await this.database((database) => {
      signal?.throwIfAborted();
      database.exec('BEGIN IMMEDIATE');
      try {
        const current: unknown = database.query('SELECT revision, snapshot FROM sessions WHERE scope = ?').get(scope);
        const revision = current === null ? 0 : sessionRowSchema.parse(current).revision;
        assertSameSession(current, original);
        const insertBlob = database.query('INSERT OR IGNORE INTO blobs (hash, text) VALUES (?, ?)');
        for (const [hash, text] of blobs) insertBlob.run(hash, text);
        if (snapshot.entries.length === 0 && snapshot.decision.reason === 'explicitly-forgotten') {
          database.query('DELETE FROM sessions WHERE scope = ?').run(scope);
        } else {
          database.query(`INSERT INTO sessions (scope, revision, snapshot) VALUES (?, ?, ?)
            ON CONFLICT(scope) DO UPDATE SET revision = excluded.revision, snapshot = excluded.snapshot`)
            .run(scope, revision + 1, serialized);
          database.query('DELETE FROM refs WHERE scope = ?').run(scope);
          const insertRef = database.query('INSERT INTO refs (scope, hash) VALUES (?, ?)');
          for (const hash of blobs.keys()) insertRef.run(scope, hash);
        }
        database.exec('DELETE FROM blobs WHERE NOT EXISTS (SELECT 1 FROM refs WHERE refs.hash = blobs.hash)');
        if (metricsChanged) {
          const lifetime = addMetrics(readLifetimeMetrics(database), metricsDelta);
          database.query("INSERT INTO meta (key, value) VALUES ('lifetime-metrics', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            .run(JSON.stringify(lifetime));
        }
        const total = numberRowSchema.parse(database.query(`SELECT
          COALESCE((SELECT SUM(length(CAST(text AS BLOB))) FROM blobs), 0)
          + COALESCE((SELECT SUM(length(CAST(snapshot AS BLOB))) FROM sessions), 0)
          + COALESCE((SELECT SUM(length(CAST(value AS BLOB))) FROM meta), 0) AS value`).get()).value;
        if (total > this.maxTotalBytes) throw new Error('Global archive full; original request retained');
        signal?.throwIfAborted();
        database.exec('COMMIT');
      } catch (error) {
        if (database.inTransaction) database.exec('ROLLBACK');
        throw error;
      }
    });
    return result;
    // @context-fold end transaction-52062fd795
  }
}
