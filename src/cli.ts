#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { statistics } from './statistics.js';

const usage = 'Usage: magpie-context-folding stats [--scope <scope>] [--json]';
const [command, ...arguments_] = process.argv.slice(2);
if (command !== 'stats') {
  console.log(usage);
  process.exitCode = command === undefined || command === '--help' ? 0 : 1;
} else {
  try {
    const { values } = parseArgs({ args: arguments_, options: { scope: { type: 'string' }, json: { type: 'boolean' } } });
    const data = await statistics(values.scope);
    if (values.json) console.log(JSON.stringify(data, null, 2));
    else {
      const m = data.metrics;
      console.log([
        `统计范围：${data.scope === 'global-lifetime' ? '全局累计' : '当前会话'}`,
        `已批准折叠：${m.foldBatchesApproved} 批，${m.itemsFolded} 个条目，其中 ${m.recursiveItemsFolded} 次递归折叠`,
        `成功带折叠请求：${m.successfulFoldedRequests}；失败：${m.failedFoldedRequests}；未核实：${m.unverifiedFoldedRequests}`,
        `累计净减少 token（估算）：${m.estimatedTokenDelta}`,
        `已验证比较的 token 减少下界：${m.certifiedTokenDeltaLower}`,
        `已验证输入费节省下界：USD ${data.money.certifiedInputSavingLowerUsd}（${m.certifiedComparisons} 次比较）`,
        `复用请求：${m.replayRequests} 次，未重复计入金额`,
        `展开读取：原文 ${m.originalReadCalls} 次、历史层 ${m.layerReadCalls} 次；恢复条目：${m.itemsRestored}`,
        `存档：${data.storage.activeSessions} 个会话，${data.storage.blobs} 个去重内容，数据库 ${data.storage.databaseBytes} B`,
        '金额以计费证书的假设为前提，不代表实际账单。未预留的标记、展开和输出费用不会自动扣除。',
      ].join('\n'));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Statistics unavailable');
    process.exitCode = 1;
  }
}
