#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import type { ParseArgsConfig } from 'node:util';
import { loadConfig } from './config.js';
import { diagnostic, execute } from './tool.js';
import { statistics } from './statistics.js';
import { formatTokenCount } from './metrics.js';
import { writeReport } from './report.js';

const usage = `Usage: magpie-context-folding <command> [options]

read   --scope S --id ID [--layer ID] [--offset N] [--limit N] [--peek] [--json]
paste  --scope S --id ID --path /new/file|- [--layer ID] [--offset N] [--limit N] [--peek]
mark   --scope S --id ID --disposition keep|unmarked|foldable [--summary TEXT]
mark   --scope S [--marks '<JSON array>'] (omit --marks or use --marks - to read stdin)
list   --scope S [--id ID] [--depth N] [--query TEXT] [--sort chronological|size|id|version]
       [--order asc|desc] [--offset N] [--limit N]
status --scope S
stats  [--scope S] [--json]
report --output /absolute/new.html [--scope S]
mode   --scope S [--mode intelligence|balanced|economy]
config [--project-dir PATH]

read writes the full exact text to stdout unless --limit selects a page; paste --path - does the same.
Other archive commands and config write JSON.
read/paste persist keep and restore all ancestor groups; --peek leaves folding unchanged.
--json returns read metadata too. Diagnostics go to stderr; errors exit 1.`;

const string = { type: 'string' } as const;
const boolean = { type: 'boolean' } as const;
const common = { json: boolean, help: boolean };
const range = { scope: string, id: string, layer: string, offset: string, limit: string, peek: boolean };
const options: Record<string, ParseArgsConfig['options']> = {
  read: { ...common, ...range },
  paste: { ...common, ...range, path: string },
  mark: { ...common, scope: string, id: string, disposition: string, summary: string, marks: string },
  list: { ...common, scope: string, id: string, depth: string, query: string, sort: string, order: string, offset: string, limit: string },
  status: { ...common, scope: string },
  stats: { ...common, scope: string },
  report: { help: boolean, output: string, scope: string },
  mode: { ...common, scope: string, mode: string },
  config: { ...common, 'project-dir': string },
};
class UsageError extends Error {}

async function main(): Promise<void> {
  const [command, ...argv] = process.argv.slice(2);
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(usage);
    return;
  }
  if (!Object.hasOwn(options, command)) throw new UsageError('Unknown command; use --help');
  let values: Record<string, string | boolean | undefined>;
  try { values = parseArgs({ args: argv, options: options[command], strict: true, allowPositionals: false }).values; }
  catch { throw new UsageError('Invalid command options; use --help'); }
  if (values.help) { console.log(usage); return; }
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
        `折叠条目：${m.itemsFolded} 个，其中 ${m.recursiveItemsFolded} 次递归折叠`,
        `成功转换请求：${m.successfulHookRequests}；失败：${m.failedHookRequests}；未核实：${m.unverifiedHookRequests}；仅提示：${m.guideOnlyRequests}`,
        `成功带折叠请求：${m.successfulFoldedRequests}；失败：${m.failedFoldedRequests}；未核实：${m.unverifiedFoldedRequests}`,
        `累计净减少 token（成功请求估算）：${formatTokenCount(m.estimatedTokenDelta)}`,
        `已验证比较的 token 减少下界：${formatTokenCount(m.certifiedTokenDeltaLower)}`,
        `证书假设下的节省下界累计：USD ${data.money.certifiedInputSavingLowerUsd}（${m.certifiedComparisons} 次比较）`,
        `复用请求：${m.replayRequests} 次，未重复计入金额`,
        `展开读取：原文 ${m.originalReadCalls} 次、历史层 ${m.layerReadCalls} 次；恢复条目：${m.itemsRestored}`,
        `存档：${data.storage.activeSessions} 个会话，${data.storage.blobs} 个去重内容，数据库 ${data.storage.databaseBytes} B`,
        '金额依赖证书假设，不代表实际账单。当前证书须覆盖同一任务全部新增工作；历史累计保留原证据限制，不升级为完整任务收益证明。',
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
  if (command === 'mark') {
    if (values.marks !== undefined) {
      if (values.id !== undefined || values.disposition !== undefined || values.summary !== undefined) {
        throw new UsageError('Use --marks or individual mark fields, not both');
      }
      const source = values.marks === '-' ? await Bun.stdin.text() : String(values.marks);
      try { args.marks = JSON.parse(source); }
      catch { throw new UsageError('Invalid marks JSON; expected an array'); }
    } else if (values.id === undefined && values.disposition === undefined && values.summary === undefined) {
      if (process.stdin.isTTY) throw new UsageError('Provide --marks, individual mark fields, or a JSON array on stdin');
      try { args.marks = JSON.parse(await Bun.stdin.text()); }
      catch { throw new UsageError('Invalid marks JSON; expected an array'); }
    } else {
      args.marks = [{ id: values.id, disposition: values.disposition, ...(values.summary === undefined ? {} : { summary: values.summary }) }];
    }
    delete args.id;
    delete args.disposition;
    delete args.summary;
  }
  const stdoutRead = command === 'read' || (command === 'paste' && values.path === '-');
  if (stdoutRead) {
    const request: Record<string, unknown> = { ...args, action: 'read' };
    delete request.path;
    const page = async (input: Record<string, unknown>) => {
      const result = JSON.parse(await execute(input)) as {
        error?: string; text: string; nextOffset: number | null; sha256: string; totalChars: number;
      };
      if (result.error) throw new UsageError(result.error);
      return result;
    };
    const result = await page({ ...request, limit: args.limit ?? 24000 });
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
    else process.stdout.write(result.text);
    return;
  }
  const result = JSON.parse(await execute(args)) as { error?: string };
  if (result.error) throw new UsageError(result.error);
  console.log(JSON.stringify(result));
}

// A consumer such as head may close stdout after receiving enough text.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0);
  console.error('Cannot write command output');
  process.exitCode = 1;
});
try { await main(); }
catch (error) {
  console.error(error instanceof UsageError ? error.message : diagnostic(error));
  process.exitCode = 1;
}
