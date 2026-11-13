import { createHash } from 'node:crypto';
import type { EffectsReport, ReportSession } from './report.js';

export function escapeHtml(value: string | number): string {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}
const number = (value: number | string): string => {
  const text = String(value);
  return /^-?\d+$/.test(text) ? BigInt(text).toLocaleString('en-US') : text;
};
const text = (value: number | string): string => escapeHtml(number(value));
const script = `document.querySelector('#theme').addEventListener('change', function () { document.documentElement.dataset.theme = this.value; });
document.querySelector('#texture').addEventListener('change', function () { document.documentElement.dataset.texture = String(this.checked); });`;
const scriptHash = createHash('sha256').update(script).digest('base64');

const css = `
:root{color-scheme:light;--surface:#fcfcfb;--plane:#f9f9f7;--ink:#0b0b0b;--secondary:#52514e;--line:#e1e0d9;--before:#2a78d6;--after:#eb6834}
:root[data-theme="dark"]{color-scheme:dark;--surface:#1a1a19;--plane:#0d0d0d;--ink:#f0efec;--secondary:#c3c2b7;--line:#2c2c2a;--before:#3987e5;--after:#d95926}
*{box-sizing:border-box}body{margin:0;background:var(--plane);color:var(--ink);font:15px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:1120px;margin:auto;padding:40px 28px 64px}h1{font-size:32px;line-height:1.25;margin:8px 0 16px;letter-spacing:-.5px}h2{font-size:21px;margin:0 0 10px}h3{font-size:17px;margin:0 0 8px}p{margin:8px 0}.eyebrow{font-size:12px;letter-spacing:1.4px}.secondary,.note,small{color:var(--secondary)}.note{font-size:13px;max-width:85ch}.toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:24px;margin:24px 0}.toolbar label{display:flex;align-items:center;gap:8px}select{background:var(--surface);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:7px 12px;font:inherit}input{accent-color:var(--before)}section{margin:28px 0;padding:24px;background:var(--surface);border:1px solid var(--line);border-radius:12px}.hero{font-size:54px;line-height:1.15;font-weight:650;margin:6px 0}.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:24px;margin:20px 0 4px}.stat-value{display:block;font-size:28px;font-weight:600}.stats p{margin:0}.money{font-size:26px;font-weight:600;overflow-wrap:anywhere}.pill{display:inline-block;font-size:12px;padding:3px 9px;border:1px solid var(--line);border-radius:20px;color:var(--secondary)}.legend{display:flex;gap:24px;flex-wrap:wrap;margin:20px 0}.key{display:inline-block;width:18px;height:10px;margin-right:7px;background:var(--before)}.key.after{background:var(--after)}.session{padding:22px 0;border-top:1px solid var(--line)}.bar-row{display:grid;grid-template-columns:70px minmax(60px,1fr) minmax(100px,140px);align-items:center;gap:12px;min-height:44px}.track{position:relative;display:flex;align-items:center;min-height:36px;border-left:1px solid var(--line);outline-offset:3px}.bar{height:16px;border-radius:0 4px 4px 0;background:var(--before);display:block}.bar.after{background:var(--after)}.track:hover .bar,.track:focus .bar{filter:brightness(1.15)}.tooltip{display:none;position:absolute;left:8px;bottom:32px;z-index:2;background:var(--surface);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:6px 10px;white-space:nowrap;box-shadow:0 3px 12px #0002}.track:hover .tooltip,.track:focus .tooltip{display:block}.bar-value{text-align:right;font-variant-numeric:tabular-nums}.axis{border-top:1px solid var(--line);display:flex;justify-content:space-between;margin-left:82px;margin-right:152px;font-size:12px;color:var(--secondary)}.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:14px;margin-top:12px}th,td{padding:10px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{color:var(--secondary);font-weight:500}td.numeric,th.numeric{text-align:right;font-variant-numeric:tabular-nums}td{overflow-wrap:anywhere}summary{cursor:pointer;padding:8px 0}code{font-size:12px;overflow-wrap:anywhere}.empty{padding:24px 0}.texture-note{font-size:12px}
:root[data-texture="true"] .bar,:root[data-texture="true"] .key{background-image:repeating-linear-gradient(45deg,transparent 0 5px,#0005 5px 7px)}:root[data-texture="true"] .after{background-image:repeating-linear-gradient(135deg,transparent 0 5px,#0005 5px 7px)}
@media(max-width:640px){main{padding:24px 16px}section{padding:18px}.stats{grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}h1{font-size:27px}.bar-row{grid-template-columns:64px minmax(35px,1fr) 95px;gap:8px}.axis{margin-left:72px;margin-right:103px}.session-table{min-width:780px}.bar-value{font-size:12px}.tooltip{white-space:normal;min-width:120px}th,td{padding:8px}}
@media print{:root,:root[data-theme="dark"]{color-scheme:light;--surface:#fff;--plane:#fff;--ink:#0b0b0b;--secondary:#52514e;--line:#e1e0d9;--before:#2a78d6;--after:#eb6834}.toolbar{display:none}body{background:white}section{break-inside:avoid}.bar,.key{print-color-adjust:exact;background-image:repeating-linear-gradient(45deg,transparent 0 5px,#0005 5px 7px)}.bar.after,.key.after{background-image:repeating-linear-gradient(135deg,transparent 0 5px,#0005 5px 7px)}}
@media(forced-colors:active){.bar,.key{forced-color-adjust:none;background:CanvasText;background-image:repeating-linear-gradient(45deg,transparent 0 5px,Canvas 5px 7px)}.bar.after,.key.after{background-image:repeating-linear-gradient(135deg,transparent 0 5px,Canvas 5px 7px)}}`;

const observationLabels = {
  pending: '请求投影待确认',
  confirmed: '已匹配成功响应',
  failed: '请求失败',
  unverified: '响应未核实',
} as const;
const observationNotes = {
  pending: '已记录本次投影；尚未收到与该投影匹配的成功响应。',
  confirmed: '宿主报告成功，且回调请求与本次投影一致；token 仍为估算，不是供应商计费读数。',
  failed: '宿主报告请求失败；本次投影对比不计为成功请求的节省。',
  unverified: '缺少成功确认，或回调请求不匹配；本次投影不计为成功请求的节省。',
} as const;

function decisionStatus(session: ReportSession): string {
  if (session.observation) return observationLabels[session.observation.status];
  return session.approved === true ? '已批准' : session.approved === false ? '未批准' : '批准状态未记录';
}

function requestObservation(session: ReportSession): string {
  const value = session.observation;
  if (!value) return '';
  const completed = value.completedAt === undefined ? '' : ` · 回调记录时间：${escapeHtml(new Date(value.completedAt).toISOString())}`;
  if (session.mode === 'observe-only') {
    return `<p class="note">基线记录时间：${escapeHtml(new Date(value.observedAt).toISOString())}${completed}</p><p class="note">${observationNotes[value.status]}</p>`;
  }
  const quantity = (count: number | undefined) => count === undefined ? '未记录' : text(count);
  return `<p class="note">记录时间：${escapeHtml(new Date(value.observedAt).toISOString())}${completed} · 本次替换区域：${quantity(value.foldedRegions)} · 输入中已有引用：${quantity(value.replayedReferences)} · 等待区域：${quantity(value.waiting)}</p><p class="note">${observationNotes[value.status]}</p>`;
}

function sessionUsage(session: ReportSession): string {
  const groups = [
    ['含折叠内容', session.usage.withFoldedContent],
    ['不含折叠内容', session.usage.withoutFoldedContent],
    ['只观测基线', session.usage.observeOnly],
    ['未分类', session.usage.unclassified],
  ] as const;
  const lines = groups.flatMap(([label, usage]) => {
    if (usage.requests === 0 && usage.unavailableRequests === 0) return [];
    return [`<p class="note">${label}：${text(usage.requests)} 个完整 usage 回复 · 输入 ${text(usage.inputTokens)} · 输出 ${text(usage.outputTokens)} · 缓存读 ${text(usage.cacheReadTokens)}（${text(usage.cacheReadUsageRequests)} 次有字段）· 缓存写 ${text(usage.cacheWriteTokens)}（${text(usage.cacheWriteUsageRequests)} 次有字段）· ${text(usage.unavailableRequests)} 个匹配成功但 usage 不完整${label === '未分类' ? '；可能来自旧版累计' : ''}</p>`];
  });
  if (lines.length === 0) return '';
  return `<div aria-label="本状态会话回复 usage"><p><strong>本状态会话回复 usage</strong></p>${lines.join('')}</div>`;
}

function comparison(session: ReportSession): string {
  const data = session.comparison;
  if (!data) return `<p class="note">没有记录前后字节数，无法绘制比较。</p>`;
  const maximum = Math.max(data.beforeBytes, data.afterBytes, 1);
  const bar = (label: string, value: number, after: boolean) => `<div class="bar-row"><span>${label}</span><div class="track" tabindex="0" aria-label="${label} ${value} UTF-8 字节"><span class="bar${after ? ' after' : ''}" style="width:${(value / maximum * 100).toFixed(4)}%"></span><span class="tooltip" role="tooltip"><strong>${text(value)} B</strong> · ${label}</span></div><span class="bar-value">${text(value)} B</span></div>`;
  if (session.mode === 'observe-only') {
    return `${bar('原始请求', data.beforeBytes, false)}${bar('原样发送', data.afterBytes, true)}<div class="axis" aria-hidden="true"><span>0</span><span>${text(maximum)} B</span></div>
  <p class="note">净变化：${text((BigInt(data.beforeBytes) - BigInt(data.afterBytes)).toString())} B。只观测模式没有改写请求，也没有添加恢复提示；相同字节数不是费用或质量结论。</p>`;
  }
  if (session.observation) {
    const beforeTokens = Math.ceil(data.beforeBytes / 4);
    const afterTokens = Math.ceil(data.afterBytes / 4);
    return `${bar('原始请求', data.beforeBytes, false)}${bar('最终投影', data.afterBytes, true)}<div class="axis" aria-hidden="true"><span>0</span><span>${text(maximum)} B</span></div>
  <p class="note">净减少：${text((BigInt(data.beforeBytes) - BigInt(data.afterBytes)).toString())} B · token 估算：${text(beforeTokens)} → ${text(afterTokens)} · 净减少 token（估算）：${text(beforeTokens - afterTokens)}。</p>
  <p class="note">比较完整输入与插件返回的完整请求，包含系统指导和恢复定位信息开销。负数表示请求变大；重放已经折叠的输入不重新记为首次折叠收益。此对比不改变客户端聊天历史，也不能证明账单节省。</p>`;
  }
  return `${bar('比较基线', data.beforeBytes, false)}${bar('候选请求', data.afterBytes, true)}<div class="axis" aria-hidden="true"><span>0</span><span>${text(maximum)} B</span></div>
  <p class="note">基线 − 候选：${text((BigInt(data.beforeBytes) - BigInt(data.afterBytes)).toString())} B。${session.approved === true ? '候选已获批准；此记录不能证明请求成功或账单变化。' : session.approved === false ? '候选未获批准；候选条形不代表实际发送。' : '批准状态未记录；候选条形不代表实际发送。'}</p>`;
}

export function renderReport(report: EffectsReport): string {
  // @context-fold begin renderReport-4add410a10
  const { sessions, statistics: stats } = report;
  const m = stats.metrics;
  const hasFoldObservation = sessions.some(session => session.observation !== undefined && session.mode === 'folding');
  const hasObserveOnlyObservation = sessions.some(session => session.observation !== undefined && session.mode === 'observe-only');
  const hasObservation = hasFoldObservation || hasObserveOnlyObservation;
  const archiveSessions = sessions.filter(session => session.entries > 0).length;
  const sum = (key: 'entries' | 'foldedEntries' | 'keptEntries' | 'layers' | 'groups' | 'foldedGroups') => sessions.reduce((total, session) => total + session[key], 0);
  const tiles = [['归档条目', sum('entries')], ['明确 keep', sum('keptEntries')], ['历史折叠层', sum('layers')], ['分组 / 已折叠分组', `${number(sum('groups'))} / ${number(sum('foldedGroups'))}`]] as const;
  const usageGroups = stats.responseUsageByFoldState;
  const usageSummary = (usage: typeof usageGroups.withFoldedContent) =>
    `${number(usage.requests)} 次 · 输入 ${number(usage.inputTokens)} · 输出 ${number(usage.outputTokens)}`;
  const usageCacheSummary = (usage: typeof usageGroups.withFoldedContent) =>
    `缓存读 ${number(usage.cacheReadTokens)}（${number(usage.cacheReadUsageRequests)} 次有字段）· 写 ${number(usage.cacheWriteTokens)}（${number(usage.cacheWriteUsageRequests)} 次有字段）`;
  const totalUsage = {
    requests: m.responseUsageRequests,
    unavailableRequests: m.responseUsageUnavailableRequests,
    inputTokens: m.responseInputTokens,
    outputTokens: m.responseOutputTokens,
    cacheReadUsageRequests: m.responseCacheReadUsageRequests,
    cacheReadTokens: m.responseCacheReadTokens,
    cacheWriteUsageRequests: m.responseCacheWriteUsageRequests,
    cacheWriteTokens: m.responseCacheWriteTokens,
  };
  const metrics: [string, number | string, string][] = [
    ['批准批次', m.foldBatchesApproved, '批准事件累计，可能包括同一条目的多次折叠'],
    ['折叠条目次数', m.itemsFolded, '包括条目与分组，不等于当前条目数量'],
    ['递归折叠次数', m.recursiveItemsFolded, '对已折叠项再次折叠'],
    ['成功转换请求', m.successfulHookRequests, '匹配成功响应'],
    ['失败转换请求', m.failedHookRequests, '失败响应'],
    ['未核实转换请求', m.unverifiedHookRequests, '未能核实的响应'],
    ['仅引导请求', m.guideOnlyRequests, '没有新折叠的引导请求'],
    ['成功带折叠请求', m.successfulFoldedRequests, '包含现有或新折叠内容'],
    ['失败带折叠请求', m.failedFoldedRequests, '失败响应'],
    ['未核实带折叠请求', m.unverifiedFoldedRequests, '不视为成功'],
    ['复用请求', m.replayRequests, '没有新证书时不重复计入金额'],
    ['原文读取 / 历史层读取', `${number(m.originalReadCalls)} / ${number(m.layerReadCalls)}`, '已有工具读取计数；生成报告不增加此计数'],
    ['恢复条目次数', m.itemsRestored, '累计恢复事件'],
    ['净减少 token（估算）', m.estimatedTokenDelta, '匹配成功响应的序列化 UTF-8 字节 / 4 估算；引导开销可使其为负'],
    ['证书 token 减少下界', m.certifiedTokenDeltaLower, '证书假设下的增量比较；与估算使用不同基线'],
    ['已核实证书比较次数', m.certifiedComparisons, '匹配成功响应；费用仍取决于证明假设'],
    ['成功回复回传 usage 总量', usageSummary(totalUsage), usageCacheSummary(totalUsage)],
    ['usage · 请求含折叠内容', usageSummary(usageGroups.withFoldedContent), usageCacheSummary(usageGroups.withFoldedContent)],
    ['usage · 请求不含折叠内容', usageSummary(usageGroups.withoutFoldedContent), usageCacheSummary(usageGroups.withoutFoldedContent)],
    ['usage · 只观测基线', usageSummary(usageGroups.observeOnly), usageCacheSummary(usageGroups.observeOnly)],
    ['usage · 未分类累计', usageSummary(usageGroups.unclassified), `${usageCacheSummary(usageGroups.unclassified)}；可能含旧版累计`],
    ['只观测回调（成功 / 失败 / 未核实）', `${number(m.observeOnlySuccessfulRequests)} / ${number(m.observeOnlyFailedRequests)} / ${number(m.observeOnlyUnverifiedRequests)}`,
      '成功数含缺少完整 usage 的匹配响应'],
    ['成功回复缺少完整 usage', `含折叠 ${number(usageGroups.withFoldedContent.unavailableRequests)} · 不含折叠 ${number(usageGroups.withoutFoldedContent.unavailableRequests)} · 只观测 ${number(usageGroups.observeOnly.unavailableRequests)} · 未分类 ${number(usageGroups.unclassified.unavailableRequests)}`,
      '只统计匹配成功回调但缺少完整字段的回复；失败请求和没有完成回调的请求不在其中'],
  ];
  return `<!doctype html>
<html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${scriptHash}'; img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><title>Context Folding · 本地效果报告</title><style>${css}</style></head>
<body><main><header><div class="eyebrow">MAGPIE / CONTEXT FOLDING</div><h1>${hasFoldObservation ? '上下文折叠效果' : hasObserveOnlyObservation ? '未折叠基线观测' : '净收益未验证'}</h1>${hasFoldObservation ? '<p class="secondary">查看最近记录的请求是否变短，以及宿主是否确认该请求成功。客户端保留的聊天历史不会随请求投影自动收起。</p>' : hasObserveOnlyObservation ? '<p class="secondary">只观测基线原样通过请求，不折叠内容或添加恢复提示；usage 仍需与相同任务、模型和输出质量下的折叠运行比较。</p>' : ''}<p class="secondary">${m.certifiedComparisons === 0 ? '尚无已核实费用比较；请求体积估算不能证明省钱或提速。' : '已有条件下界；实际账单节省与耗时改善仍未测得。'}</p><p class="note">本地只读快照 · ${escapeHtml(report.generatedAt)} · ${stats.scope === 'session' ? '所选会话累计' : '全局累计'}</p></header>
<div class="toolbar" aria-label="显示选项"><label>外观 <select id="theme"><option value="light">浅色</option><option value="dark">深色</option></select></label><label><input id="texture" type="checkbox"> 图形纹理</label><span class="note">离线文件 · 无外部资源</span></div>
<section aria-labelledby="current"><h2 id="current">当前归档快照</h2><p class="secondary">${text(archiveSessions)} 个会话含可恢复归档</p><div class="hero">${text(sum('foldedEntries'))}</div><p class="note">归档数量不代表最近记录的请求实际包含的折叠数量。分组覆盖的子条目不重复折算为“已折叠条目”；分组单独计数。keep 是明确保护标记，不等于所有未折叠条目。</p><div class="stats">${tiles.map(([label, value]) => `<p><span class="secondary">${label}</span><span class="stat-value">${text(value)}</span></p>`).join('')}</div></section>
<section aria-labelledby="comparison"><h2 id="comparison">${hasFoldObservation ? '最近记录的请求：折叠投影对比' : hasObserveOnlyObservation ? '最近只观测基线：原样发送' : '最近决策：请求字节对比'}</h2><p class="note">${hasFoldObservation && hasObserveOnlyObservation ? '每个会话仅展示最后一次折叠投影或只观测基线；核对记录时间和回调状态。字节数按完整 JSON 计算；折叠投影包含系统指导和恢复定位信息，基线原样发送。token 按字节数 / 4 估算，不代表账单或质量。' : hasFoldObservation ? '每个会话仅展示最后一次记录；未进入投影流程的后续请求不会更新此快照，请核对记录时间。原始请求与最终投影均按完整 JSON 的 UTF-8 字节计数，最终投影包含系统指导和恢复定位信息；token 按字节数 / 4 向上取整。响应状态单独核实，未确认不按成功计算。旧版记录保留其原有基线和批准语义。' : hasObserveOnlyObservation ? '每个会话仅展示最后一次只观测请求。插件将原请求原样发送；输入和发送字节数相同。成功状态须由匹配的响应回调确认，usage 仍不是账单，也不证明折叠节省。' : '每个会话仅保留最后一次决策。基线是新增折叠前、复用已有折叠后且未加入新引导的请求；候选包含拟发送的引导和恢复定位开销。单位为序列化 UTF-8 字节，各会话独立刻度。这不是 tokenizer 实测，也不是完整对话原文与摘要的体积比较。'}</p>
<p class="note">回复 usage 按状态会话分别累计，便于人工并排查看隔离运行；报告不会自动配对同一任务、模型或输出质量。</p>
<div class="legend" aria-label="图例"><span><i class="key"></i>${hasObserveOnlyObservation && !hasFoldObservation ? '原始请求' : hasObservation ? '输入 / 旧版基线' : '比较基线'}</span><span><i class="key after"></i>${hasObserveOnlyObservation && !hasFoldObservation ? '原样发送' : hasObservation ? '投影 / 旧版候选' : '候选请求'}</span></div>
${sessions.length ? sessions.map(session => `<article class="session"><h3>${escapeHtml(session.label)}</h3><p><span class="pill">${decisionStatus(session)}</span> ${escapeHtml(session.reason)}</p>${requestObservation(session)}${sessionUsage(session)}<p class="note"><strong>下一步查什么：</strong>${escapeHtml(session.nextCheck)}</p>${comparison(session)}</article>`).join('') : '<p class="empty">还没有用量观测或归档会话。使用插件后重新生成报告。</p>'}
<details><summary>查看会话数据表</summary><div class="table-wrap"><table class="session-table"><thead><tr><th>会话</th><th>条目</th><th>独立折叠</th><th>keep</th><th>层</th><th>组 / 折叠组</th><th>${hasObserveOnlyObservation && !hasFoldObservation ? '原始请求 B' : '输入 / 基线 B'}</th><th>${hasObserveOnlyObservation && !hasFoldObservation ? '原样发送 B' : '投影 / 候选 B'}</th><th>最后原因</th></tr></thead><tbody>${sessions.map(s => `<tr><td>${escapeHtml(s.label)}</td><td>${text(s.entries)}</td><td>${text(s.foldedEntries)}</td><td>${text(s.keptEntries)}</td><td>${text(s.layers)}</td><td>${text(s.groups)} / ${text(s.foldedGroups)}</td><td>${s.comparison ? text(s.comparison.beforeBytes) : '未记录'}</td><td>${s.comparison ? text(s.comparison.afterBytes) : '未记录'}</td><td>${escapeHtml(s.reason)}</td></tr>`).join('')}</tbody></table></div></details></section>
<section aria-labelledby="money"><h2 id="money">费用证据</h2><p class="secondary">证书假设下的节省下界累计 · USD</p><p class="money">${m.certifiedComparisons === 0 ? '无费用证明' : escapeHtml(stats.money.certifiedInputSavingLowerUsd)}</p><p class="note">覆盖 ${text(m.certifiedComparisons)} 次已核实比较。金额依赖证书中的 token、价格、缓存和费用边界假设；没有新证书的复用请求不重复计入。当前证书必须覆盖同一任务全部新增工具调用、模型往返、输入输出及直接费用；历史累计保留原证据限制，不能升级为完整任务收益证明。</p><p><strong>实际账单节省：未知</strong> <code>actualBillSavingUsd = null</code></p><p class="note">回复回传的 usage 可帮助比较真实请求用量，但仍不是账单，也没有提供同一任务未折叠时的反事实。实际耗时改善与额外操作费用：未知，不按零计算。读取、恢复次数单独列在统计中；次数不能换算成实际费用。</p></section>
<section aria-labelledby="counters"><h2 id="counters">${stats.scope === 'session' ? '所选会话累计' : '全局累计'}统计</h2><p class="note">累计计数不是当前折叠数量。全局累计在归档清除后仍可保留，因此可能高于当前快照。</p><div class="table-wrap"><table><thead><tr><th>指标</th><th class="numeric">记录值</th><th>含义</th></tr></thead><tbody>${metrics.map(([label, value, detail]) => `<tr><td>${label}</td><td class="numeric">${text(value)}</td><td>${detail}</td></tr>`).join('')}</tbody></table></div><p class="note">全局存储：${text(stats.storage.activeSessions)} 个状态会话 · ${text(stats.storage.blobs)} 个去重内容块 · 数据库 ${text(stats.storage.databaseBytes)} B（不是发送体积）。</p></section>
<footer><p class="note">范围与限制：只展示匿名计数和固定原因名称，不输出原文、摘要、路径、会话能力值、模型名或证书自由文本。会话编号仅供本文件阅读，不能跨报告追踪。统计与归档元数据分别以只读快照读取，并发请求可能使两者略有差异。未保存历史请求日志，无法补画时间趋势；响应回调丢失也不能推断为成功。</p></footer></main><script>${script}</script></body></html>`;
  // @context-fold end renderReport-4add410a10
}
