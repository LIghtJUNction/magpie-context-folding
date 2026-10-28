#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import type { ParseArgsConfig } from 'node:util';
import { ConfigError, loadConfig } from './config.js';
import { diagnostic, execute } from './tool.js';
import { statistics } from './statistics.js';
import { formatTokenCount } from './metrics.js';
import { writeReport } from './report.js';
import { formatVisibility, hookNotification, readClientInput, visibleSessions, visibility } from './visibility.js';
import type { VisibilitySelection } from './visibility.js';

const usage = `Usage: magpie-context-folding <command> [options]

read   --scope S --id HASH [--layer ID] [--start-line N --end-line N | --offset N]
       [--limit N | --full | --all | --restore] [--peek] [--json]
grep   --scope S --query TEXT [--id HASH] [--no-recursive] [--limit N] [--offset N] [--json]
list   --scope S [--id HASH] [--recursive] [--depth N] [--query TEXT]
       [--sort chronological|size|id|version] [--order asc|desc] [--limit N] [--offset N] [--json]
meta   --scope S --id HASH [--offset N] [--limit N] [--json]
paste  --scope S --id HASH --path /new/file|- [--layer ID] [--offset N] [--limit N] [--json]
status --scope S
stats  [--scope S] [--json]
statusline [--scope S] [--client] [--json]
sessions [--json]
hook   [--scope S] (Stop hook JSON on stdin; one UI notification per confirmed request)
report --output /absolute/new.html [--scope S]
forget --scope S [--force]
config [--project-dir PATH]

Archive commands accept --state-dir PATH to select the Magpie archive explicitly.
read returns at most 1200 UTF-16 units of one view; nested children remain references.
--full exports the complete selected view; --all exports the complete original layer by default.
With --offset, --full/--all export from that offset to the end of the selected layer.
--layer original selects the exact archived bytes; neither export recursively expands stored references.
--restore returns the complete original and keeps the selected subtree visible in future requests.
Ordinary read/paste never change folding state. paste defaults to the complete one-layer view.
grep/list return 10 short results by default; meta returns sizes and direct child IDs.
statusline is read-only; without a scope/client binding it shows explicitly global totals.
--client matches stdin session_id only when exactly one gateway scope has the same identity.
MAGPIE_CONTEXT_FOLDING_SCOPE supplies an explicit scope for statusline/hook.
--json returns structured data. Diagnostics go to stderr; errors exit 1.`;

const string = { type: 'string' } as const;
const boolean = { type: 'boolean' } as const;
const common = { json: boolean, help: boolean };
const archive = { ...common, 'state-dir': string };
const range = { scope: string, id: string, layer: string, offset: string, limit: string, peek: boolean,
  'start-line': string, 'end-line': string };
const options: Record<string, ParseArgsConfig['options']> = {
  read: { ...archive, ...range, all: boolean, full: boolean, restore: boolean },
  paste: { ...archive, ...range, path: string },
  list: { ...archive, scope: string, id: string, depth: string, recursive: boolean, query: string,
    sort: string, order: string, offset: string, limit: string },
  grep: { ...archive, scope: string, id: string, query: string, recursive: boolean, 'no-recursive': boolean,
    'case-sensitive': boolean, offset: string, limit: string },
  meta: { ...archive, scope: string, id: string, offset: string, limit: string },
  status: { ...archive, scope: string },
  stats: { ...archive, scope: string },
  statusline: { ...archive, scope: string, client: boolean },
  sessions: { ...archive },
  hook: { help: boolean, scope: string, 'state-dir': string },
  report: { help: boolean, output: string, scope: string, 'state-dir': string },
  forget: { ...archive, scope: string, force: boolean },
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
  if ((values.all || values.full) && values.limit !== undefined) throw new UsageError('Choose a complete export or --limit, not both');
  if (values.all && values.full) throw new UsageError('Choose --all for original bytes or --full for the selected view');
  if (values.restore && (values.limit !== undefined || values.offset !== undefined || values['start-line'] !== undefined
    || values['end-line'] !== undefined || (values.layer !== undefined && values.layer !== 'original'))) {
    throw new UsageError('--restore requires the complete original without range or view options');
  }
  if (values.restore && values.peek) throw new UsageError('Choose --restore or --peek, not both');
  if (values['state-dir'] !== undefined) {
    const directory = values['state-dir'];
    if (typeof directory !== 'string' || !directory.trim() || directory.includes('\0')) {
      throw new UsageError('Provide a nonempty --state-dir path');
    }
    process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = directory;
  }
  if (command === 'sessions') {
    const data = await visibleSessions();
    if (values.json) console.log(JSON.stringify({ sessions: data }));
    else console.log(data.length ? data.map(session => `${session.scope} · 归档 ${session.archivedEntries} 项 · ${formatVisibility({ selection: 'session', request: session.request })}`).join('\n')
      : '还没有归档会话。');
    return;
  }
  if (command === 'statusline' || command === 'hook') {
    const scope = values.scope ?? process.env.MAGPIE_CONTEXT_FOLDING_SCOPE;
    if (scope !== undefined && (typeof scope !== 'string' || !/^[a-f0-9]{64}$/.test(scope))) throw new UsageError('Invalid scope');
    const client = command === 'hook' || values.client === true;
    let input: { sessionId?: string; event?: string } = {};
    if (client) {
      try { input = await readClientInput(process.stdin); }
      catch { throw new UsageError('Invalid or oversized client JSON'); }
    }
    const selection: VisibilitySelection = { client, ...(scope === undefined ? {} : { scope }),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }) };
    if (command === 'hook') console.log(JSON.stringify(await hookNotification(selection, input.event)));
    else {
      const data = await visibility(selection);
      console.log(values.json ? JSON.stringify(data) : formatVisibility(data));
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
    if (value === undefined || ['json', 'help', 'all', 'full', 'restore', 'state-dir'].includes(key)) continue;
    if (['offset', 'limit', 'depth', 'start-line', 'end-line'].includes(key)) {
      if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new UsageError('Expected a nonnegative integer for range/depth options');
      }
      args[key === 'start-line' ? 'startLine' : key === 'end-line' ? 'endLine' : key] = Number(value);
    } else if (key === 'no-recursive') { if (value) args.recursive = false; }
    else args[key === 'case-sensitive' ? 'caseSensitive' : key] = value;
  }
  const stdoutRead = command === 'read' || (command === 'paste' && values.path === '-');
  if (stdoutRead) {
    const request: Record<string, unknown> = { ...args, action: 'read' };
    delete request.path;
    request.peek = values.restore !== true;
    if (values.restore || (values.all && values.layer === undefined)) request.layer = 'original';
    const page = async (input: Record<string, unknown>) => {
      const result = JSON.parse(await execute(input)) as {
        error?: string; id: string; text: string; nextOffset: number | null; sha256: string; viewSha256: string; totalChars: number;
      };
      if (result.error) throw new UsageError(result.error);
      return result;
    };
    const full = values.full === true || values.all === true || values.restore === true || (command === 'paste' && args.limit === undefined);
    if (full && (args.startLine !== undefined || args.endLine !== undefined)) throw new UsageError('Full export cannot combine with a line range');
    const result = await page({ ...request, limit: args.limit ?? (full ? 24000 : 1200) });
    request.id = result.id;
    const chunks = [result.text];
    let nextOffset = result.nextOffset;
    while (full && args.limit === undefined && nextOffset !== null) {
      const next = await page({ ...request, peek: true, offset: nextOffset, limit: 24000 });
      if (next.viewSha256 !== result.viewSha256 || next.totalChars !== result.totalChars) {
        throw new UsageError('Context archive changed during reading; retry request');
      }
      chunks.push(next.text);
      nextOffset = next.nextOffset;
    }
    result.text = chunks.join('');
    result.nextOffset = nextOffset;
    if (values.json) console.log(JSON.stringify(result));
    else {
      await Bun.write(Bun.stdout, result.text);
      if (nextOffset !== null) console.error(`More: --offset ${nextOffset} (use --full for the rest of this view)`);
    }
    return;
  }
  const result = JSON.parse(await execute(args)) as { error?: string; entries?: { id: string; key: string; label?: string; depth: number; chars: number; childCount: number }[];
    matches?: { id: string; key: string; line: number; text: string }[]; nextOffset?: number | null };
  if (result.error) throw new UsageError(result.error);
  if (!values.json && result.entries && command === 'list') {
    for (const item of result.entries) console.log('  '.repeat(item.depth) + item.key + ' ' + (item.label ?? '') + ' (' + item.chars + ' chars, ' + item.childCount + ' children)');
    if (result.nextOffset !== null) console.log('nextOffset=' + result.nextOffset);
  } else if (!values.json && result.matches && command === 'grep') {
    for (const item of result.matches) console.log(item.key + ':' + item.line + ':' + item.text);
    if (result.nextOffset !== null) console.log('nextOffset=' + result.nextOffset);
  } else console.log(JSON.stringify(result));
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
