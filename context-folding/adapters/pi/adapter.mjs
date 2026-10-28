import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
export const entryType = 'context-folding/pi-read/v1';
const digest = text => createHash('sha256').update(text).digest('hex');
export const scopeFor = ctx => `pi:${digest(JSON.stringify([resolve(ctx.cwd), ctx.sessionManager.getSessionId()]))}`;

/** Same JSON request contract as the standalone core; no provider or Pi dependency. */
export function createCore({ statePath, python = 'python3', projectDir }) {
  if (!statePath || !statePath.startsWith('/')) throw new Error('Absolute statePath required');
  const corePath = fileURLToPath(new URL('../../python/', import.meta.url));
  // Isolated interpreter: never import a project's sitecustomize or cwd modules.
  const bootstrap = 'import sys; sys.path.insert(0, sys.argv.pop(1)); from context_folding.cli import main; raise SystemExit(main())';
  return async request => {
    const payload = JSON.stringify(request);
    const stdout = await new Promise((resolveOutput, reject) => {
      const child = execFile(python, ['-I', '-c', bootstrap, corePath,
        'call', '--state', statePath, ...(projectDir ? ['--project-dir', projectDir] : []), '--json', '-'],
      { cwd: '/', maxBuffer: 16 * 1024 * 1024, timeout: 10000 },
      (error, output) => error ? reject(new Error('Core process failed')) : resolveOutput(output));
      // Requests may contain source/secrets: never put their contents in argv.
      child.stdin.on('error', () => reject(new Error('Core input failed')));
      child.stdin.end(payload);
    });
    const envelope = JSON.parse(stdout);
    if (envelope.error || !envelope.result) throw new Error('Core request failed');
    return envelope.result;
  };
}

const activeSnapshots = (ctx, scope) => ctx.sessionManager.getBranch().filter(entry =>
  entry.type === 'custom' && entry.customType === entryType && entry.data?.scope === scope
  && typeof entry.data.id === 'string');

/** Post-tool output has no replay cycle. With the default delay, preserve the result.
 * An explicit delay_requests=0 configuration allows an immediate annotated view.
 * Undefined means Pi keeps its complete original result.
 */
export function createReadAdapter({ call, appendEntry, minChars = 1000 }) {
  return async (event, ctx) => {
    try {
      if (event.toolName !== 'read' || event.isError || event.content.length !== 1
        || event.content[0].type !== 'text' || typeof event.input.path !== 'string'
        || !event.input.path.endsWith('.py')
        || !['offset', 'limit'].every(key => event.input[key] === undefined
          || (Number.isSafeInteger(event.input[key]) && event.input[key] > 0))) return;
      const original = event.content[0].text;
      if (original.length < minChars || Buffer.byteLength(original) > 100000) return;
      const scope = scopeFor(ctx);
      // Never pass path to core: annotations apply only to the exact approved read result.
      const annotated = await call({ action: 'annotate', scope, text: original, language: 'python' });
      if (typeof annotated.id !== 'string' || annotated.sha256 !== digest(original)) return;
      const id = annotated.id;
      // Explicit source projection validates its archive identity and page.
      const view = await call({ action: 'read-source', scope, id, mode: 'folded', limit: 24000 });
      if (view.id !== id || view.nextOffset !== null || typeof view.text !== 'string'
          || !view.foldedRegions?.length) return;
      const output = `[Pi read snapshot ${id}; inspect with context_folding_query list/grep/read/meta; references stay folded.]\n${view.text}`;
      if (output.length >= original.length) return;
      // Persist before pinning: no-benefit reads and persistence failures never
      // change retention, including pins set by earlier reads or other owners.
      // If pinning fails, a harmless branch record remains but no view is published.
      appendEntry(entryType, { scope, id, sha256: digest(original) });
      await call({ action: 'pin', scope, id, pinned: true });
      return { content: [{ ...event.content[0], text: output }] };
    } catch { return; }
  };
}

/** Recover only snapshots recorded in this session's active branch. No arbitrary scope/path input. */
export async function restoreOriginal(call, ctx, id) {
  const scope = scopeFor(ctx);
  const record = activeSnapshots(ctx, scope).find(entry => entry.data.id === id);
  if (!record) throw new Error('Snapshot unavailable in the active session branch');
  // Explicit legacy recovery only. The normal query tool never substitutes it
  // into a previous assistant/tool message or silently marks a fold as keep.
  const restored = await call({ action: 'resolve', scope, value: `[[cf:v1:${id}]]` });
  if (restored.resolved !== 1 || typeof restored.value !== 'string') throw new Error('Invalid recovery');
  const text = restored.value;
  if (digest(text) !== record.data.sha256) throw new Error('Snapshot integrity check failed');
  return text;
}

/** Query only the current branch's snapshot tree; default to its newest root. */
export async function querySnapshot(call, ctx, request) {
  const scope = scopeFor(ctx);
  const snapshots = activeSnapshots(ctx, scope);
  if (!snapshots.length || !['list', 'grep', 'read', 'meta'].includes(request.action)) throw new Error('Query unavailable');
  const root = snapshots.at(-1).data.id;
  const target = request.id ?? root;
  // Prevent a branch from traversing another branch's archived read, even when
  // the Pi host reuses a session ID for multiple branches.
  const matches = new Map();
  for (const snapshot of snapshots) {
    let offset = 0;
    for (let page = 0; page < 100; page++) {
      const list = await call({ action: 'list', scope, id: snapshot.data.id, recursive: true, offset, limit: 100 });
      for (const entry of list.entries) if (entry.id === target
        || (typeof target === 'string' && target.length >= 12 && entry.sha256?.startsWith(target))) {
        matches.set(entry.id, entry.sha256);
      }
      if (list.nextOffset === null) break;
      if (!Number.isSafeInteger(list.nextOffset) || list.nextOffset <= offset) throw new Error('Invalid listing');
      offset = list.nextOffset;
    }
  }
  if (!matches.size || new Set(matches.values()).size !== 1) {
    throw new Error('Snapshot unavailable or ambiguous in the active branch');
  }
  const resolvedId = [...matches.keys()][0];
  const fields = {};
  for (const name of ['offset', 'limit', 'depth', 'recursive', 'context', 'query', 'startLine', 'endLine']) {
    if (request[name] !== undefined) fields[name] = request[name];
  }
  return call({ action: request.action, scope, id: resolvedId, ...fields });
}
