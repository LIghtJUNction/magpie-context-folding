import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';

export interface ClientOptions {
  statePath: string;
  pythonExecutable?: string;
  /** Arguments before --state PATH; defaults to -m context_folding rpc. */
  pythonArguments?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxResponseBytes?: number;
}
export interface Request extends Record<string, unknown> { action: string; scope: string }
export type Fields = Readonly<Record<string, unknown>>;

export class ContextFoldingError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ContextFoldingError';
  }
}

/** A subprocess bridge to the separately installed Python engine, not a native core. */
export class ContextFoldingClient implements AsyncDisposable {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: Interface;
  private readonly maxResponseBytes: number;
  private tail: Promise<void> = Promise.resolve();
  private failure?: Error;
  private stderrText = '';
  private responseBytes = 0;
  private pending?: { resolve: (value: unknown) => void; reject: (error: Error) => void };
  private readonly exited: Promise<void>;

  constructor(options: ClientOptions) {
    if (!options.statePath) throw new TypeError('statePath is required');
    this.maxResponseBytes = options.maxResponseBytes ?? 64 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1) throw new TypeError('Invalid maxResponseBytes');
    this.child = spawn(options.pythonExecutable ?? 'python3',
      [...(options.pythonArguments ?? ['-m', 'context_folding', 'rpc']), '--state', options.statePath],
      { stdio: ['pipe', 'pipe', 'pipe'], ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.env ? { env: { ...process.env, ...options.env } } : {}) });
    this.exited = new Promise(resolve => { this.child.once('close', () => resolve()); });
    this.child.once('error', error => this.fail(new ContextFoldingError('transport', `Cannot start Python engine: ${error.message}`)));
    this.child.once('exit', (code, signal) => this.fail(new ContextFoldingError('transport',
      `Python engine exited (code=${code}, signal=${signal})${this.stderrText ? `: ${this.stderrText}` : ''}`)));
    this.child.stdin.on('error', error => this.fail(new ContextFoldingError('transport', `Engine input failed: ${error.message}`)));
    this.child.stdout.on('error', error => this.fail(new ContextFoldingError('transport', `Engine output failed: ${error.message}`)));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (text: string) => { this.stderrText = (this.stderrText + text).slice(-16384); });
    this.child.stderr.on('error', () => { /* Diagnostics must not interrupt the response channel. */ });
    // Bound incomplete lines too, before readline can accumulate unlimited data.
    this.child.stdout.on('data', (chunk: Buffer) => {
      for (const byte of chunk) {
        this.responseBytes = byte === 10 ? 0 : this.responseBytes + 1;
        if (this.responseBytes > this.maxResponseBytes) {
          this.fail(new ContextFoldingError('protocol', 'Engine response exceeds maxResponseBytes'));
          break;
        }
      }
    });
    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.lines.on('line', line => this.receive(line));
    this.lines.once('close', () => {
      if (!this.failure) this.fail(new ContextFoldingError('transport', 'Python engine closed its output'));
    });
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(error);
    // Hard termination also handles unresponsive engines and cancellation.
    this.child.kill('SIGKILL');
  }

  private receive(line: string): void {
    if (this.failure) return;
    const pending = this.pending;
    if (!pending) { this.fail(new ContextFoldingError('protocol', 'Unsolicited engine response')); return; }
    let envelope: unknown;
    try { envelope = JSON.parse(line); }
    catch { this.fail(new ContextFoldingError('protocol', 'Engine returned invalid JSON')); return; }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      this.fail(new ContextFoldingError('protocol', 'Invalid response envelope')); return;
    }
    const response = envelope as Record<string, unknown>;
    if (Object.keys(response).length !== 1 || (!Object.hasOwn(response, 'result') && !Object.hasOwn(response, 'error'))) {
      this.fail(new ContextFoldingError('protocol', 'Invalid response envelope')); return;
    }
    this.pending = undefined;
    if (Object.hasOwn(response, 'result')) { pending.resolve(response.result); return; }
    const error = response.error;
    if (!error || typeof error !== 'object' || !('code' in error) || typeof error.code !== 'string'
      || !('message' in error) || typeof error.message !== 'string') {
      this.pending = pending;
      this.fail(new ContextFoldingError('protocol', 'Invalid error envelope')); return;
    }
    pending.reject(new ContextFoldingError(error.code, error.message));
  }

  call<T = unknown>(request: Request, signal?: AbortSignal): Promise<T> {
    if (!request || typeof request.action !== 'string' || !request.action || typeof request.scope !== 'string' || !request.scope) {
      return Promise.reject(new TypeError('Request requires action and scope'));
    }
    let line: string;
    try { line = JSON.stringify(request) + '\n'; }
    catch (error) { return Promise.reject(error); }
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let active = false;
      const cleanup = () => { signal?.removeEventListener('abort', abort); };
      const finish = (error: unknown, value?: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error !== undefined) reject(error); else resolve(value as T);
      };
      const abort = () => {
        const error = new ContextFoldingError('cancelled', 'Request cancelled; dispatched requests terminate the bridge');
        if (active) this.fail(error);
        finish(error);
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const run = this.tail.then(async () => {
        if (settled) return;
        if (this.failure) { finish(this.failure); return; }
        active = true;
        try {
          const response = new Promise<unknown>((resolveResponse, rejectResponse) => {
            this.pending = { resolve: resolveResponse, reject: rejectResponse };
            this.child.stdin.write(line, error => { if (error) this.fail(new ContextFoldingError('transport', error.message)); });
          });
          finish(undefined, await response);
        } catch (error) { finish(error); }
        finally { active = false; }
      });
      this.tail = run.catch(error => { finish(error); });
    });
  }

  /** Immediately project explicitly marked text using the shared Python archive. */
  fold<T = unknown>(scope: string, text: string, fields: Fields = {}, signal?: AbortSignal): Promise<T> {
    return this.call<T>({ ...fields, action: 'fold', scope, text }, signal);
  }
  put<T = unknown>(scope: string, text: string, fields: Fields = {}, signal?: AbortSignal): Promise<T> {
    return this.call<T>({ ...fields, action: 'put', scope, text }, signal);
  }
  list<T = unknown>(scope: string, fields: Fields = {}, signal?: AbortSignal): Promise<T> {
    return this.call<T>({ ...fields, action: 'list', scope }, signal);
  }
  grep<T = unknown>(scope: string, query: string, fields: Fields = {}, signal?: AbortSignal): Promise<T> {
    return this.call<T>({ ...fields, action: 'grep', scope, query }, signal);
  }
  meta<T = unknown>(scope: string, id: string, fields: Fields = {}, signal?: AbortSignal): Promise<T> {
    return this.call<T>({ ...fields, action: 'meta', scope, id }, signal);
  }
  read<T = unknown>(scope: string, id: string, fields: Fields = {}, signal?: AbortSignal): Promise<T> {
    return this.call<T>({ ...fields, action: 'read', scope, id }, signal);
  }
  render<T = unknown>(scope: string, ids: readonly string[], fields: Fields = {}, signal?: AbortSignal): Promise<T> {
    return this.call<T>({ ...fields, action: 'render', scope, ids }, signal);
  }
  resolve<T = unknown>(scope: string, value: unknown, fields: Fields = {}, signal?: AbortSignal): Promise<T> {
    return this.call<T>({ ...fields, action: 'resolve', scope, value }, signal);
  }

  async dispose(): Promise<void> {
    this.fail(new ContextFoldingError('disposed', 'Context folding bridge disposed'));
    await this.exited;
    this.lines.close();
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
  }
  async [Symbol.asyncDispose](): Promise<void> { await this.dispose(); }
}
