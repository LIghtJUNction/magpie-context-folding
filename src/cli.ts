#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import type { ParseArgsConfig } from 'node:util';
import { ConfigError, loadConfig } from './config.js';
import { diagnostic, execute } from './tool.js';
import { statistics } from './statistics.js';
import { formatTokenCount } from './metrics.js';
import { writeReport } from './report.js';
import { foldConversation } from './fold.js';
import { Store } from './store.js';
import { RangeSelectionError, type ConversationRange } from './ranges.js';
import type { Protocol } from './protocol.js';

const usage = `Usage: magpie-context-folding <command> [options]

fold-messages --range JSON [--protocol chat|responses|anthropic|gemini] [--scope S] [--json]
read   --scope S --id ID [--layer ID] [--offset N] [--limit N] [--peek] [--json]
paste  --scope S --id ID --path /new/file|- [--layer ID] [--offset N] [--limit N] [--peek]
list   --scope S [--id ID] [--depth N] [--query TEXT] [--sort chronological|size|id|version]
       [--order asc|desc] [--offset N] [--limit N]
status --scope S
stats  [--scope S] [--json]
report --output /absolute/new.html [--scope S]
forget --scope S (requires restored entries and group manifests)
config [--project-dir PATH]

read writes the full exact text to stdout unless --limit selects a page; paste --path - does the same.
Other archive commands and config write JSON.
read/paste persist keep and restore all ancestor groups; --peek leaves folding unchanged.
Read/paste accept exact IDs or unambiguous content hash prefixes (at least 12 hex digits).
fold-messages reads a complete request JSON from stdin and replaces the selected range with one user reference.
Range: {"start":{"message":0,"offset":0},"end":{"message":4}}. Indices are zero-based; end is exclusive.
Offsets count Unicode code points. Omit an offset for the boundary before that message.
Originals are ordinary files; read/search directly or delegate a focused question to a lightweight subagent.
Automatic hook folding also accepts @context-fold begin/end annotations across messages.
--json returns read metadata too. Diagnostics go to stderr; errors exit 1.`;

const string = { type: 'string' } as const;
const boolean = { type: 'boolean' } as const;
const common = { json: boolean, help: boolean };
const range = { scope: string, id: string, layer: string, offset: string, limit: string, peek: boolean };
const options: Record<string, ParseArgsConfig['options']> = {
  'fold-messages': { ...common, scope: string, protocol: string, range: string },
  read: { ...common, ...range },
  paste: { ...common, ...range, path: string },
  list: { ...common, scope: string, id: string, depth: string, query: string, sort: string, order: string, offset: string, limit: string },
  status: { ...common, scope: string },
  stats: { ...common, scope: string },
  report: { help: boolean, output: string, scope: string },
  forget: { ...common, scope: string },
  config: { ...common, 'project-dir': string },
};
class UsageError extends Error {}

async function main(): Promise<void> {
  // @context-fold begin main-5a1db74d0b
  const [command, ...argv] = process.argv.slice(2);
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(usage);
    return;
  }
  if (command === 'mark' || command === 'mode') throw new UsageError('mark/mode were removed; use @context-fold begin/end annotations to request folding');
  if (!Object.hasOwn(options, command)) throw new UsageError('Unknown command; use --help');
  let values: Record<string, string | boolean | undefined>;
  try { values = parseArgs({ args: argv, options: options[command], strict: true, allowPositionals: false }).values; }
  catch { throw new UsageError('Invalid command options; use --help'); }
  if (values.help) { console.log(usage); return; }
  if (command === 'fold-messages') {
    if (typeof values.range !== 'string') throw new UsageError('Provide --range JSON with start and end message positions');
    const protocol = values.protocol ?? 'chat';
    if (!['chat', 'responses', 'anthropic', 'gemini'].includes(String(protocol))) throw new UsageError('Invalid protocol');
    let body: unknown;
    let selection: unknown;
    try { body = JSON.parse(await Bun.stdin.text()); selection = JSON.parse(values.range); }
    catch { throw new UsageError('Input and --range must be valid JSON'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new UsageError('Expected a complete request JSON object');
    if (values.scope !== undefined && (typeof values.scope !== 'string' || !/^[a-f0-9]{64}$/.test(values.scope))) throw new UsageError('Invalid scope');
    const store = new Store();
    const scope = values.scope as string | undefined ?? await store.scopeFor(JSON.stringify(['cli', process.cwd()]));
    try {
      const result = await foldConversation(body as Record<string, unknown>, protocol as Protocol, selection as ConversationRange, scope, store);
      console.log(JSON.stringify(values.json ? result : result.body));
    } catch (error) {
      if (error instanceof RangeSelectionError) throw new UsageError(error.message);
      throw error;
    }
    return;
  }
  if (command === 'report') {
    if (typeof values.output !== 'string') throw new UsageError('Provide --output /absolute/new.html');
    if (values.scope !== undefined && !/^[a-f0-9]{64}$/.test(String(values.scope))) throw new UsageError('Invalid scope');
    try { await writeReport(values.output, values.scope as string | undefined); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        throw new UsageError('Report destination already exists; choose a new file');
      }
      if (error instanceof Error && error.message === 'Report output must be an absolute path to a new file') {
        throw new UsageError(error.message);
      }
      throw new UsageError('Cannot create report; check the archive and a new output path with an existing parent');
    }
    console.log('本地效果报告已生成。用浏览器打开指定的 HTML 文件。');
    return;
  }
  if (command === 'config') {
    console.log(JSON.stringify(await loadConfig(values['project-dir'] as string | undefined)));
    return;
  }
  if (command === 'stats') {
    if (values.scope !== undefined && !/^[a-f0-9]{64}$/.test(String(values.scope))) throw new UsageError('Invalid scope');
    const data = await statistics(values.scope as string | undefined);
    if (values.json) console.log(JSON.stringify(data));
    else {
      const m = data.metrics;
      console.log([
        `统计范围：${data.scope === 'global-lifetime' ? '全局累计' : '当前会话'}`,
        `折叠次数：${data.summary.foldCount}`,
        `查看详情次数：${data.summary.detailViewCount}`,
        `累计折叠 token（估算）：${data.summary.foldedTokensDisplay}`,
        `累计净减少 token（成功请求估算）：${formatTokenCount(m.estimatedTokenDelta)}`,
        `存档：${data.storage.activeSessions} 个会话，${data.storage.blobs} 个内容，数据库 ${data.storage.databaseBytes} B`,
        'token 为估算值，不代表实际账单节省。',
      ].join('\n'));
    }
    return;
  }
  const args: Record<string, unknown> = { action: command };
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || key === 'json' || key === 'help') continue;
    if (['offset', 'limit', 'depth'].includes(key)) {
      if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new UsageError('Expected a nonnegative integer for range/depth options');
      }
      args[key] = Number(value);
    } else args[key] = value;
  }
  const stdoutRead = command === 'read' || (command === 'paste' && values.path === '-');
  if (stdoutRead) {
    const request: Record<string, unknown> = { ...args, action: 'read' };
    delete request.path;
    const page = async (input: Record<string, unknown>) => {
      const result = JSON.parse(await execute(input)) as {
        error?: string; id: string; text: string; nextOffset: number | null; sha256: string; totalChars: number;
      };
      if (result.error) throw new UsageError(result.error);
      return result;
    };
    const result = await page({ ...request, limit: args.limit ?? 24000 });
    request.id = result.id;
    const chunks = [result.text];
    let nextOffset = result.nextOffset;
    while (args.limit === undefined && nextOffset !== null) {
      const next = await page({ ...request, peek: true, offset: nextOffset, limit: 24000 });
      if (next.sha256 !== result.sha256 || next.totalChars !== result.totalChars) {
        throw new UsageError('Context archive changed during reading; retry request');
      }
      chunks.push(next.text);
      nextOffset = next.nextOffset;
    }
    result.text = chunks.join('');
    result.nextOffset = nextOffset;
    if (values.json) console.log(JSON.stringify(result));
    else await Bun.write(Bun.stdout, result.text);
    return;
  }
  const result = JSON.parse(await execute(args)) as { error?: string };
  if (result.error) throw new UsageError(result.error);
  console.log(JSON.stringify(result));
  // @context-fold end main-5a1db74d0b
}

try { await main(); }
catch (error) {
  // A consumer such as head may close stdout after receiving enough text.
  if (!(error instanceof Error && 'code' in error && error.code === 'EPIPE')) {
    console.error(error instanceof UsageError || error instanceof ConfigError ? error.message : diagnostic(error));
    process.exitCode = 1;
  }
}
