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

async function readAll(call, scope, id, mode, peek = false) {
  let text = '', offset = 0;
  for (let count = 0; count < 100; count++) {
    const part = await call({ action: 'read', scope, id, mode, peek, offset, limit: 24000 });
    if (part.id !== id || part.offset !== offset || typeof part.text !== 'string') throw new Error('Invalid read');
    text += part.text;
    if (part.nextOffset === null) {
      if (Array.from(text).length !== part.totalChars || digest(text) !== part.sha256) throw new Error('Incomplete read');
      return text;
    }
    if (!Number.isSafeInteger(part.nextOffset) || part.nextOffset <= offset) throw new Error('Invalid continuation');
    offset = part.nextOffset;
  }
  throw new Error('Read too large');
}

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
      if (typeof annotated.id !== 'string') return;
      const id = annotated.id;
      // Verify restoration before replacing anything.
      if (await readAll(call, scope, id, 'original', true) !== original) return;
      const folded = await readAll(call, scope, id, 'folded');
      const output = `[Pi read snapshot: ${JSON.stringify(event.input)}; restore exact original with context_folding_restore id=${id}. Fold references are display-only; restore before editing.]\n${folded}`;
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
  const record = ctx.sessionManager.getBranch().find(entry => entry.type === 'custom'
    && entry.customType === entryType && entry.data?.scope === scope && entry.data?.id === id);
  if (!record) throw new Error('Snapshot unavailable in the active session branch');
  const text = await readAll(call, scope, id, 'original');
  if (digest(text) !== record.data.sha256) throw new Error('Snapshot integrity check failed');
  return text;
}
