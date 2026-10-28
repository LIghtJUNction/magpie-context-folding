import { Database } from 'bun:sqlite';
import { stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { stateDirectory } from './store.js';
import { statistics } from './statistics.js';
import { renderReport } from './report-html.js';

const reasons: Record<string, string> = {
  'annotated-regions-folded': '本次请求含折叠内容',
  'annotation-grace-period': '闭合标记仍在等待周期',
  'no-eligible-annotations': '本次没有可折叠区域',
  'insufficient-net-savings': '折叠净收益不足，保留原文',
  proven: '费用下界证明通过',
  'saving-not-proven': '未证明费用节省',
  'bytes-smaller-no-cost-proof': '字节更少；没有费用证明',
  'below-threshold': '未达到估算阈值',
  'no-marked-smaller-candidates': '没有已标记且更小的候选',
  'batch-not-smaller': '候选批次没有变小',
  'accounting-unavailable': '费用证明服务不可用',
  'policy-candidate-planning-failed': '候选生成失败',
  'policy-certificate-script-failed': '证明脚本失败',
  'policy-cost-bounds-missing': '缺少费用边界',
  'policy-incremental-cost-bounds-missing': '缺少新增工作成本边界',
  'invalid-policy': '策略无效',
  'invalid-policy-request': '策略请求无效',
  'invalid-proof-settings': '证明设置无效',
  'invalid-certificate': '证书无效',
  'certificate-request-mismatch': '证书与请求不匹配',
  'certificate-model-mismatch': '证书与模型不匹配',
  'certificate-protocol-mismatch': '证书与协议不匹配',
  'certificate-expired': '证书已过期',
  'non-finite-cost-bounds': '费用边界无效',
  'explicitly-forgotten': '归档已明确清除',
};
const nextChecks: Record<string, string> = {
  'insufficient-net-savings': '完整请求的缩减未达到收益门槛，已保留原文。指导、CLI 路径和恢复定位开销已计入；不需要为短片段反复折叠或回查。',
  'annotated-regions-folded': '查看本次请求前后大小和响应核实状态。插件替换发给模型的请求视图，客户端保留的聊天历史不会因此收起。',
  'annotation-grace-period': '正文已经归档，当前请求仍保留原文。等待配置要求的后续不同请求；相同请求的重试不推进等待周期。',
  'no-eligible-annotations': '本次没有符合条件的闭合标记。检查完整配对的标记、明确保留的内容和引用开销；归档条目数不代表本次折叠数。',
  proven: '核对匹配成功响应的累计计数与证书假设；批准记录本身不能证明请求成功或账单节省。',
  'saving-not-proven': '检查同一任务的输入价格、缓存损失及全部新增工作成本；多一次工具调用或模型往返可能抵消收益。',
  'bytes-smaller-no-cost-proof': '当前只证明候选字节更少。需要费用判断时，补齐相同任务全部新增成本边界并使用 cost 模式。',
  'below-threshold': '用 config 检查实际生效的 threshold_tokens；阈值比较使用完整请求 UTF-8 字节 / 4 的估算。',
  'no-marked-smaller-candidates': '在本机用 list/status 检查 foldable 标记、近期消息和最新文件保护，以及摘要是否更小；此记录没有指出具体是哪一项阻止折叠。',
  'batch-not-smaller': '检查完整候选中的引导、恢复标识和引用开销；仅摘要更短还不足以让整个请求变小。',
  'accounting-unavailable': '在本机检查费用服务是否可达、超时和证书响应格式；不要把服务地址、凭据或请求正文贴入报告。',
  'policy-candidate-planning-failed': '检查候选策略脚本的退出状态、超时和输出格式；归档没有保存脚本错误详情。',
  'policy-certificate-script-failed': '检查证明脚本的退出状态、超时和证书格式；脚本失败不会回退到更宽松的证明。',
  'policy-cost-bounds-missing': '补齐输入、缓存价格与 token 边界，并核对完整的新增工作成本；未知费用不能填零。',
  'policy-incremental-cost-bounds-missing': '补齐相同任务新增的工具调用次数、模型往返次数、合计输入和输出 token、价格及工具直接费用上界；未知值不能填零，合计费用不再乘次数。',
  'invalid-policy': '用 config 检查实际生效的策略字段和边界；不要分享未经脱敏的本机配置。',
  'invalid-policy-request': '检查宿主传给策略的 model、protocol、before 和 after 格式。',
  'invalid-proof-settings': '检查最小节省金额等证明设置是否为有效的非负有限数。',
  'invalid-certificate': '检查证书必填字段、完整 incremental 七字段、数值范围和有效期；缺失成本不能默认零。',
  'certificate-request-mismatch': '为当前完整 before/after 请求重新生成绑定证书；包含真实引导和恢复元数据，不能复用旧请求的证明。',
  'certificate-model-mismatch': '核对证书与当前请求的模型绑定及适用价格。',
  'certificate-protocol-mismatch': '核对证书与当前请求的协议绑定。',
  'certificate-expired': '按当前请求和时间重新生成证书，并检查本机时钟。',
  'non-finite-cost-bounds': '检查 token 和费用边界是否溢出或包含非有限值；不能用无法计算的金额批准折叠。',
  'explicitly-forgotten': '归档已清除；旧请求的前后比较无法从当前归档重建。后续正常使用后重新生成报告。',
};
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const observation = z.object({
  observedAt: count.max(8_640_000_000_000_000),
  completedAt: count.max(8_640_000_000_000_000).optional(),
  status: z.enum(['pending', 'confirmed', 'failed', 'unverified']),
});
// Parse metadata only. IDs stay internal to count group coverage; never output them.
const metadata = z.object({
  entries: z.array(z.object({
    id: z.string(), mark: z.object({ disposition: z.enum(['keep', 'unmarked', 'foldable']) }),
    foldedHash: z.string().optional(), layers: z.array(z.unknown()).default([]),
  })),
  groups: z.array(z.object({ id: z.string(), children: z.array(z.string()), folded: z.string().optional() })).default([]),
  decision: z.object({ reason: z.unknown().optional(), approved: z.boolean().optional(),
    beforeBytes: count.optional(), afterBytes: count.optional(),
    foldedRegions: count.optional(), replayedReferences: count.optional(), waiting: count.optional(),
    observation: observation.optional() }).default({}),
});

export interface ReportSession {
  label: string;
  entries: number;
  foldedEntries: number;
  keptEntries: number;
  layers: number;
  groups: number;
  foldedGroups: number;
  reason: string;
  nextCheck: string;
  approved: boolean | null;
  comparison: { beforeBytes: number; afterBytes: number } | null;
  observation?: z.infer<typeof observation> & {
    foldedRegions?: number;
    replayedReferences?: number;
    waiting?: number;
  };
}
export interface EffectsReport {
  generatedAt: string;
  statistics: Awaited<ReturnType<typeof statistics>>;
  sessions: ReportSession[];
}

export async function collectReport(scope?: string): Promise<EffectsReport> {
  // @context-fold begin collectReport-03e463b91a
  if (scope !== undefined && !/^[a-f0-9]{64}$/.test(scope)) throw new Error('Invalid scope');
  const stats = await statistics(scope);
  const path = join(stateDirectory(), 'state.sqlite');
  const sessions: ReportSession[] = [];
  let exists = true;
  try { await stat(path); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    exists = false;
  }
  if (exists) {
    const database = new Database(path, { readonly: true, strict: true });
    try {
      database.exec('PRAGMA busy_timeout = 2000');
      database.exec('BEGIN');
      const query = scope === undefined
        ? database.query('SELECT snapshot FROM sessions ORDER BY scope').iterate()
        : database.query('SELECT snapshot FROM sessions WHERE scope = ?').iterate(scope);
      for (const row of query) {
        const raw = z.object({ snapshot: z.string() }).parse(row);
        const snapshot = metadata.parse(JSON.parse(raw.snapshot));
        const d = snapshot.decision;
        const groups = new Map(snapshot.groups.map(group => [group.id, group]));
        const covered = new Set<string>();
        const pending = snapshot.groups.filter(group => group.folded !== undefined).flatMap(group => group.children);
        while (pending.length) {
          const id = pending.pop()!;
          if (covered.has(id)) continue;
          covered.add(id);
          pending.push(...(groups.get(id)?.children ?? []));
        }
        const reason = typeof d.reason === 'string' && Object.hasOwn(reasons, d.reason)
          ? `${reasons[d.reason]} (${d.reason})` : '无记录或未识别的原因（已隐藏原值）';
        sessions.push({
          label: `会话 ${sessions.length + 1}`, entries: snapshot.entries.length,
          foldedEntries: snapshot.entries.filter(entry => entry.foldedHash !== undefined && !covered.has(entry.id)).length,
          keptEntries: snapshot.entries.filter(entry => entry.mark.disposition === 'keep').length,
          layers: snapshot.entries.reduce((sum, entry) => sum + entry.layers.length, 0),
          groups: snapshot.groups.length,
          foldedGroups: snapshot.groups.filter(group => group.folded !== undefined).length,
          reason,
          nextCheck: typeof d.reason === 'string' && Object.hasOwn(nextChecks, d.reason)
            ? nextChecks[d.reason]!
            : '证据不足，无法定位原因。先在本机确认目标插件是否启用、状态目录是否正确，以及宿主是否声明 context_folding 工具；这些只是检查项，不是已确认的根因。',
          approved: d.approved ?? null,
          comparison: d.beforeBytes !== undefined && d.afterBytes !== undefined
            ? { beforeBytes: d.beforeBytes, afterBytes: d.afterBytes } : null,
          ...(d.observation === undefined ? {} : { observation: {
            ...d.observation,
            ...(d.foldedRegions === undefined ? {} : { foldedRegions: d.foldedRegions }),
            ...(d.replayedReferences === undefined ? {} : { replayedReferences: d.replayedReferences }),
            ...(d.waiting === undefined ? {} : { waiting: d.waiting }),
          } }),
        });
      }
      database.exec('COMMIT');
    } finally { database.close(); }
  }
  if (scope !== undefined && sessions.length === 0) throw new Error('Unknown context scope');
  return { generatedAt: new Date().toISOString(), statistics: stats, sessions };
  // @context-fold end collectReport-03e463b91a
}

export async function writeReport(output: string, scope?: string): Promise<void> {
  if (!isAbsolute(output)) throw new Error('Report output must be an absolute path to a new file');
  const report = await collectReport(scope);
  // O_EXCL refuses an existing file or symlink; never truncate or change its permissions.
  await writeFile(output, renderReport(report), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}
