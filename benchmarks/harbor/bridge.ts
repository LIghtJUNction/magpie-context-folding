/** One isolated Harbor trial -> the real Magpie hooks, over JSON Lines.
 *
 * The Python agent owns the original transcript and sandbox tools. This process
 * only projects requests and recovers its own archive; it never runs agent shell
 * commands. All stdout is protocol data. No Magpie server is required.
 */
import { createInterface } from 'node:readline';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onRequest, onResponse } from '../../src/context.hooks.js';
import { statistics } from '../../src/statistics.js';

type RecordValue = Record<string, unknown>;
type Mode = 'baseline' | 'folding';
const record = (value: unknown): value is RecordValue => value !== null
  && typeof value === 'object' && !Array.isArray(value);
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const MAX_LINE_BYTES = 16 * 1024 * 1024;

class BridgeError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function requireCondition(value: unknown, code: string, message: string): asserts value {
  if (!value) throw new BridgeError(code, message);
}

export class FoldingBridge {
  private mode: Mode | undefined;
  private scope: string | null = null;
  private pending: { body: unknown; state: RecordValue } | undefined;
  private closed = false;

  constructor(private readonly session: string, private readonly cwd: string) {
    requireCondition(session.length > 0 && session.length <= 200, 'configuration',
      'HARBOR_FOLDING_SESSION must identify one trial');
    requireCondition(isAbsolute(cwd), 'configuration', 'HARBOR_FOLDING_CWD must be absolute');
    for (const name of ['MAGPIE_CONTEXT_FOLDING_STATE_DIR', 'XDG_CONFIG_HOME']) {
      const value = process.env[name];
      requireCondition(value && isAbsolute(value), 'configuration',
        `${name} must be an absolute, trial-isolated directory`);
    }
  }

  get isClosed(): boolean { return this.closed; }

  async dispatch(input: unknown): Promise<unknown> {
    requireCondition(record(input), 'invalid_request', 'Expected a JSON object');
    requireCondition(!this.closed, 'closed', 'Bridge is closed');
    if (input.op === 'project') {
      requireCondition(!this.pending, 'request_pending', 'Complete the previous request first');
      requireCondition(input.mode === 'baseline' || input.mode === 'folding',
        'invalid_mode', 'Mode must be baseline or folding');
      requireCondition(this.mode === undefined || this.mode === input.mode,
        'mode_changed', 'Use a separate bridge process for each mode');
      requireCondition(record(input.body) && typeof input.body.model === 'string'
        && input.body.model.length > 0 && Array.isArray(input.body.messages),
      'invalid_request', 'Expected a Chat Completions body with model and messages');
      this.mode = input.mode;
      const state: RecordValue = {};
      const start = performance.now();
      // Pin the treatment's protocol settings. The parent also isolates config
      // discovery so personal configuration cannot silently change a benchmark.
      const body = await onRequest(input.body, {
        protocol: 'chat', model: input.body.model, session: this.session,
        agent: 'harbor', origin: 'harbor-benchmark', cwd: this.cwd, state,
        options: { enabled: this.mode === 'folding', delayRequests: 1,
          // The benchmark's terminal is a real executable shell wrapper.
          // Other clients retain the production tool-name discovery rules.
          ...(Array.isArray(input.body.tools) && input.body.tools.some(tool => record(tool)
            && tool.type === 'function' && record(tool.function) && tool.function.name === 'terminal')
            ? { shellToolName: 'terminal' } : {}),
          maxSessionBytes: 64 * 1024 * 1024 },
      });
      const projectionMs = performance.now() - start;
      // Read only the hook's trusted completion state, never a scope-shaped
      // string from user/model text. Failed projections create no new capability.
      const hookState = state.contextFoldingStatistics;
      if (record(hookState) && typeof hookState.scope === 'string'
          && /^[a-f0-9]{64}$/.test(hookState.scope)) {
        requireCondition(this.scope === null || this.scope === hookState.scope,
          'scope_changed', 'The trial archive scope changed unexpectedly');
        this.scope = hookState.scope;
      }
      this.pending = { body, state };
      return { body, scope: this.scope, input_bytes: bytes(input.body), output_bytes: bytes(body),
        projection_ms: projectionMs, folded: record(hookState) && hookState.folded === true };
    }
    if (input.op === 'response') {
      requireCondition(this.pending, 'no_request', 'No projected request is pending');
      requireCondition(typeof input.success === 'boolean', 'invalid_request',
        'Response requires success=true or success=false');
      const pending = this.pending;
      this.pending = undefined;
      // Accounting is bound to the exact projected payload sent by the parent.
      // Provider token/cost usage is measured independently by the Python agent.
      await onResponse(undefined, { state: pending.state, request: pending.body, success: input.success });
      return { recorded: true };
    }
    if (input.op === 'cli') {
      requireCondition(!this.pending, 'request_pending', 'Complete the previous request first');
      requireCondition(Array.isArray(input.argv) && input.argv.length > 0 && input.argv.length <= 32
        && input.argv.every(value => typeof value === 'string' && value.length <= 4096 && !value.includes('\0')),
      'invalid_request', 'CLI requires a bounded array of arguments');
      const argv = input.argv as string[];
      requireCondition(['read', 'list', 'grep', 'meta', 'status'].includes(argv[0]!),
        'unsupported_action', 'Only read, list, grep, meta and status are available in benchmarks');
      requireCondition(this.scope !== null && this.mode === 'folding',
        'archive_unavailable', 'This trial has no recovery archive');
      const confined: string[] = [];
      for (let index = 0; index < argv.length; index++) {
        const argument = argv[index]!;
        if (argument === '--scope' || argument.startsWith('--scope=')) {
          const scope = argument === '--scope' ? argv[++index] : argument.slice('--scope='.length);
          requireCondition(scope === this.scope, 'scope_mismatch', 'Recovery is restricted to this trial');
        } else if (argument === '--state-dir' || argument.startsWith('--state-dir=')) {
          const directory = argument === '--state-dir' ? argv[++index] : argument.slice('--state-dir='.length);
          requireCondition(typeof directory === 'string' && isAbsolute(directory)
            && resolve(directory) === resolve(process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR!),
          'scope_mismatch', 'Recovery is restricted to this trial archive directory');
        } else confined.push(argument);
      }
      // This is the installed CLI contract over the existing shell tool, not a
      // model-visible recovery tool. Never pass model text to a host shell.
      const child = Bun.spawn([process.execPath, fileURLToPath(new URL('../../src/cli.ts', import.meta.url)),
        ...confined, '--scope', this.scope], { cwd: this.cwd, env: process.env,
        stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      let output = stdout;
      if (argv[0] === 'status' && exitCode === 0) {
        // Agent status is compact; benchmark validation still needs the actual
        // completion counters. Enrich only this private CLI bridge response.
        let status: unknown;
        try { status = JSON.parse(stdout); } catch { /* --help remains ordinary text. */ }
        if (record(status) && typeof status.entries === 'number' && !('error' in status)) {
          output = JSON.stringify({ ...status, metrics: (await statistics(this.scope)).metrics }) + '\n';
        }
      }
      return { exit_code: exitCode, stdout: output, stderr };
    }
    if (input.op === 'close') {
      await this.close();
      return { closed: true };
    }
    throw new BridgeError('unsupported_operation', 'Unknown bridge operation');
  }

  async close(): Promise<void> {
    if (this.pending) {
      const pending = this.pending;
      this.pending = undefined;
      // EOF/close does not prove the provider received or completed the request.
      await onResponse(undefined, { state: pending.state, request: pending.body });
    }
    this.closed = true;
  }
}

async function main(): Promise<void> {
  const bridge = new FoldingBridge(process.env.HARBOR_FOLDING_SESSION ?? '',
    process.env.HARBOR_FOLDING_CWD ?? process.cwd());
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let id: string | number | null = null;
      try {
        requireCondition(Buffer.byteLength(line, 'utf8') <= MAX_LINE_BYTES,
          'request_too_large', 'Bridge request exceeds 16 MiB');
        let input: unknown;
        try { input = JSON.parse(line); }
        catch { throw new BridgeError('invalid_json', 'Expected one JSON object per line'); }
        if (record(input) && ((typeof input.id === 'string' && input.id.length <= 128)
            || (typeof input.id === 'number' && Number.isSafeInteger(input.id)))) id = input.id;
        const result = await bridge.dispatch(input);
        process.stdout.write(JSON.stringify({ id, ok: true, result }) + '\n');
      } catch (error) {
        // Never echo a source payload, path, model argument or exception trace.
        const known = error instanceof BridgeError;
        process.stdout.write(JSON.stringify({ id, ok: false, error: {
          code: known ? error.code : 'bridge_error',
          message: known ? error.message : 'The folding bridge could not complete the operation',
        } }) + '\n');
      }
      if (bridge.isClosed) break;
    }
  } finally {
    lines.close();
    await bridge.close();
  }
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof BridgeError ? error.message : 'Folding bridge initialization failed');
    process.exitCode = 1;
  });
}
