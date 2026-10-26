import { isAbsolute, resolve } from 'node:path';
import { digest } from './store.js';
import type { Entry, Snapshot } from './store.js';
import type { Span } from './protocol.js';
import { latestVersions } from './tree.js';

function lines(text: string): Map<string, number> {
  const result = new Map<string, number>();
  for (const line of text.split('\n')) result.set(line, (result.get(line) ?? 0) + 1);
  return result;
}

function similarity(left: string, right: string): number {
  if (left === right) return 1;
  if (Math.min(left.length, right.length) < 1024 || Math.max(left.length, right.length) > 262144) return 0;
  const a = lines(left), b = lines(right);
  if (Math.min(a.size, b.size) < 8) return 0;
  let shared = 0;
  for (const [line, count] of a) shared += (line.length + 1) * Math.min(count, b.get(line) ?? 0);
  return shared / (Math.max(left.length, right.length) + 1);
}

function oldDifferences(oldText: string, newText: string): string | undefined {
  const remaining = lines(newText);
  const unique: string[] = [];
  let length = 0;
  for (const line of oldText.split('\n')) {
    const count = remaining.get(line) ?? 0;
    if (count > 0) remaining.set(line, count - 1);
    else {
      length += JSON.stringify(line).length + 1;
      if (length > 1400) return undefined;
      unique.push(line);
    }
  }
  return JSON.stringify(unique);
}

// The strings are quoted evidence; similarity never establishes semantic supersession.
export function trackVersions(snapshot: Snapshot, spans: Span[], cwd?: string, observations?: ReadonlyMap<string, string>): Set<string> {
  const byId = new Map(snapshot.entries.map(entry => [entry.id, entry]));
  const heads = new Map<string, Entry>();
  for (const entry of snapshot.entries) {
    if (entry.version && (!heads.has(entry.version.series)
      || heads.get(entry.version.series)!.version!.number <= entry.version.number)) heads.set(entry.version.series, entry);
  }
  const knownVersions = new Set(snapshot.entries.filter(entry => entry.version).map(entry => entry.id));
  const knownObservations = new Set(snapshot.entries.flatMap(entry => entry.version?.observations ?? []));
  const priorLatest = latestVersions(snapshot);
  const currentHeads = new Map(snapshot.entries.filter(entry => priorLatest.has(entry.id))
    .map(entry => [entry.version!.series, entry]));
  const newlyObserved = new Map<string, Entry>();
  const similarityCandidates: Entry[] = [];
  const present = new Set(spans.map(span => span.id));
  for (const span of spans) {
    const entry = byId.get(span.id);
    if (!entry) continue;
    if (!entry.version && span.role !== 'user') {
      let previous: Entry | undefined;
      let series: string | undefined;
      let file: { path: string; range: string } | undefined;
      if (span.source && (isAbsolute(span.source.path) || cwd)) {
        file = { path: resolve(cwd ?? '/', span.source.path), range: span.source.range };
        series = `file-${digest(JSON.stringify([file.path, file.range])).slice(0, 24)}`;
        previous = heads.get(series);
      } else if (!span.source && (span.role === 'tool' || span.role === 'assistant') && span.text.length >= 1024) {
        const candidates = similarityCandidates.filter(candidate => candidate.role === entry.role
          && (!candidate.version || candidate.version.kind === 'similar')).slice(-64);
        let best = 0.92;
        for (const candidate of candidates) {
          const score = similarity(candidate.text, entry.text);
          if (score >= best) { previous = candidate; best = score; }
        }
        if (previous) {
          series = previous.version?.series ?? `similar-${digest(JSON.stringify([entry.role, previous.id])).slice(0, 24)}`;
          previous.version ??= { series, kind: 'similar', number: 1, ...(previous.manual ? { automatic: false } : {}) };
        }
      }
      if (series) {
        entry.version = {
          series, kind: file ? 'file' : 'similar',
          number: previous ? previous.version!.number + (previous.text === entry.text ? 0 : 1) : 1,
          ...(previous && previous.text !== entry.text ? { previousId: previous.id }
            : previous?.version?.previousId ? { previousId: previous.version.previousId } : {}),
          ...file,
          ...(entry.manual ? { automatic: false } : {}),
        };
        heads.set(series, entry);
      }
    }
    if (!span.source && (span.role === 'tool' || span.role === 'assistant') && span.text.length >= 1024) similarityCandidates.push(entry);
    if (entry.version) {
      const version = entry.version;
      const observation = observations?.get(span.id) ?? digest(JSON.stringify([span.id, span.source ?? null]));
      const head = currentHeads.get(version.series);
      // Occurrence suffixes can change after trimming identical results. Move
      // the protected alias only when it still identifies the current content.
      if (head?.text === entry.text && head.role === entry.role && head.version?.observations?.includes(observation)) {
        currentHeads.set(version.series, entry);
      }
      const initialized = version.observations !== undefined;
      const seen = version.observations ??= [];
      if (!seen.includes(observation)) {
        seen.push(observation);
        // Each legacy entry's first visit only seeds replay identity. Its
        // numeric head remains authoritative unless a genuinely new entry appears.
        if (!knownObservations.has(observation) && (initialized || !knownVersions.has(entry.id))) {
          newlyObserved.set(version.series, entry);
        }
      }
    }
  }
  // Similarity can assign a series to a preceding candidate after its visit.
  // Seed that candidate too, so replay does not manufacture a new observation.
  for (const span of spans) {
    const version = byId.get(span.id)?.version;
    if (version && !version.observations) version.observations = [observations?.get(span.id)
      ?? digest(JSON.stringify([span.id, span.source ?? null]))];
  }
  for (const [series, entry] of newlyObserved) currentHeads.set(series, entry);
  for (const entry of snapshot.entries) {
    if (entry.version) entry.version.latest = currentHeads.get(entry.version.series)?.id === entry.id;
  }
  const latestIds = latestVersions(snapshot);
  for (const entry of snapshot.entries) {
    const version = entry.version;
    if (!version || !present.has(entry.id) || version.automatic === false || entry.mark.disposition === 'keep') continue;
    const latest = currentHeads.get(version.series);
    if (!latest || latest.id === entry.id) {
      if (version.automatic) {
        entry.mark = { disposition: 'unmarked' };
        delete entry.folded;
        delete version.automatic;
      }
      continue;
    }
    if (entry.mark.disposition === 'foldable' && !version.automatic) continue;
    const difference = oldDifferences(entry.text, latest.text);
    // Preserve every old-only line inline. Large differences require an agent summary.
    if (difference === undefined) continue;
    const summary = version.kind === 'file'
      ? `File observation ${JSON.stringify(version.path)} range=${JSON.stringify(version.range)} v${version.number}; later observation id=${latest.id} (content v${latest.version!.number}). Old-only lines (quoted, original order in archive): ${difference}`
      : `Similar historical ${entry.role} fragment v${version.number}; later fragment v${latest.version!.number} id=${latest.id}. Similarity is not supersession. Old-only lines (quoted, original order in archive): ${difference}`;
    if (summary.length > 2000) continue;
    entry.mark = { disposition: 'foldable', summary };
    version.automatic = true;
  }
  return latestIds;
}
