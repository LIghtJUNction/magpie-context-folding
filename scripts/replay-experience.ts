#!/usr/bin/env bun
/** Offline request replay: no provider, model, billing or task-quality claims. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

type Body = Record<string, unknown>;
type Message = { role: string; content?: string; tool_calls?: unknown[]; tool_call_id?: string };
type Snapshot = import('../src/store.js').Snapshot;
const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
let pluginRoot = scriptRoot;
let expectImproved = false;
for (let index = 0; index < argv.length; index++) {
  const argument = argv[index];
  if (argument === '--plugin-root' && argv[index + 1]) pluginRoot = resolve(argv[++index]!);
  else if (argument === '--expect-improved') expectImproved = true;
  else throw new Error('Usage: bun scripts/replay-experience.ts [--plugin-root PATH] [--expect-improved]');
}

const hooks: typeof import('../src/context.hooks.js') = await import(pathToFileURL(join(pluginRoot, 'src/context.hooks.ts')).href);
const tool: typeof import('../src/tool.js') = await import(pathToFileURL(join(pluginRoot, 'src/tool.ts')).href);
const storage: typeof import('../src/store.js') = await import(pathToFileURL(join(pluginRoot, 'src/store.ts')).href);
const protocol: typeof import('../src/protocol.js') = await import(pathToFileURL(join(pluginRoot, 'src/protocol.ts')).href);
const index: typeof import('../src/index.js') = await import(pathToFileURL(join(pluginRoot, 'src/index.ts')).href);
const descriptor = (await index.ContextFoldingPlugin()).tool.context_folding;
const supportsRestore = JSON.stringify(descriptor.args).includes('"const":"restore"');
const tokenEstimate = (value: unknown): number => Math.ceil(Buffer.byteLength(JSON.stringify(value)) / 4);
const textBytes = (value: string): number => Buffer.byteLength(value);
const marked = (label: string, text: string): string => `<!-- @context-fold begin ${label} -->\n${text}\n<!-- @context-fold end ${label} -->`;
const userConstraint = 'Keep user requirements, unresolved failures, source provenance and tool call/result IDs intact. Do not change source files.';
const conclusion = '保留结论：只改 sourceMarkerOffsets 的明确注释识别；未闭合字面量保留原文；下一步检查恢复接口。';

// Public, deterministic review notes; these are fixtures, not a claimed model run.
const reviewNotes = [
  '已完成的源码审阅记录：sourceMarkerOffsets 逐字符扫描文件，只把确定处于注释开头的位置提供给注释配对器。下面记录已经检查的输入类别；当前任务的约束和后续待办留在折叠区域外。',
  '路径与语言：先用扩展名区分 Python 和 JavaScript/TypeScript。其他语言返回 undefined，交给整行字面协议处理；这不等于已经有完整语法解析。tsx/jsx 中遇到疑似标签时返回空集合，避免把 JSX 正文当作可靠源码注释。',
  '整行要求：comment(at) 找到当前物理行起点，只有注释前面全是空白才记录偏移。变量赋值之后的行尾注释不会成为折叠边界。这个判断不需要猜测注释含义，它只验证标记是否独占行。',
  '换行处理：endOfLine 同时查找 CR 和 LF。引用替换时正文最后一个物理换行保留在引用外；Windows 的 CRLF 和 Unix 的 LF 不应相互改写。原始字节决定哈希，不能在归档之前统一换行。',
  '普通字符串：quoted 从开引号后开始找匹配闭引号。遇到反斜线跳过转义字符；遇到反斜线加 CRLF 时跨过两个换行字符。字符串中的 // 或 # 只是数据，不能成为注释标记。',
  'Python 三引号：连续三个相同引号作为一个 delimiter。单引号字符串遇到未转义换行时认为无法可靠解析；三引号允许物理换行。文档字符串里的整行 @context-fold 示例应保留为字面文本。',
  'Python f-string：前缀检测到 f/F 以及可能的 r/R 后，不继续尝试解析表达式。这里的保守回退会少折一些源码，但不会把表达式里的字符串、花括号或者伪注释错误解释为边界。',
  'JavaScript 模板字符串：template 跳过反斜线转义，遇到反引号结束，遇到 ${ 则递归检查表达式。纯模板正文中的标记保持普通字符；只有返回普通源码扫描状态后才可能记录注释偏移。',
  '模板表达式：expression 维护花括号深度，字符串和嵌套模板交给 quoted 处理。普通 // 和 /* */ 注释分别跳到行尾或块尾。在不能区分正则与除法的斜线处停止，并让整份源码保持完整。',
  '块注释：只有找到 */ 才认为这一段完整。没有闭合符时返回空集合，避免根据残缺输入改写后续正文。注释配对器还会独立拒绝跨越多行外壳的畸形标记，词法过滤不代替协议校验。',
  '正则字面量：扫描器尝试跳过同一物理行中的正则，包括转义与字符类。这个近似只用于减少把引号误当成字符串开头的机会；它不是 JavaScript parser，复杂含糊输入必须保持原文。',
  '源码读取来源：请求钩子通过 read 工具调用参数确认文件路径，并要求单一可用文本结果。普通 exec 输出即使包含相同标记，也不能被冒认为文件版本；失败、截断、重复调用 ID 和多部分输出都需要保留。',
  '工具协议：工具调用名称、参数、调用 ID 及对应结果外壳必须原样保留。替换仅发生在已经验证的文本切片中。不能通过删除整条工具消息来省 tokens，否则会破坏下一次模型请求的结构。',
  '会话边界：新用户消息截断未闭合的 Assistant 范围；用户的新要求不能被先前开始标记吞掉。一个任务中的多个 Assistant 文本切片可以共同闭合，但工具结果不能替 Assistant 发出结束指令。',
  '请求延迟：相同请求重试不推进等待周期。首次看到完整闭合区域时记录出现位置；下一次不同请求才满足默认的一周期延迟。内容哈希相同的新一次文件读取仍然必须获得观察机会。',
  '原文完整性：SHA-256 来自实际折叠正文的 UTF-8 字节。恢复读取必须指向那一份快照，而不是当前文件。代码后来改变、标记标签相同或者短哈希前缀冲突，都不能改变旧引用的含义。',
  '收益核算：完整请求的估算以 JSON UTF-8 字节除以四向上取整。正文变短并不自动等于请求变短，因为新引用、恢复定位提示、工具调用及恢复输出也占空间。该估算不能证明供应商账单下降。',
  '只读查阅：只想回查一个片段时，应只把该页原文放进工具结果，归档保持折叠。显式恢复是另一项操作，表示后续投影保留原文。两者混在一起会让一次查询永久抵消前面取得的缩短。',
  '重试与并发：同一会话的请求钩子和恢复工具都可能读写归档。若读取后的快照修订号已经改变，不能拿旧副本覆盖新状态。恢复可以重新读取并重试，导出文件必须放在重试循环之外，避免一次操作创建多份文件。',
  '容量保护：max_session_bytes 管理保存原文需要的空间，它不是内容重要性的评分，也不是折叠起点。正文持久化失败时请求必须保持完整；不能因为引用已经算出来就先返回缩短后的内容，让恢复入口指向不存在的数据。',
  '分页单位：JavaScript 的字符串切片按 UTF-16 单元计数，与 Python 的 Unicode 码点偏移不同。调用者必须沿 nextOffset 继续读取。文件导出还要拒绝拆开代理对的区间，避免把一个 emoji 分成两个无效字符后写进文件。',
  '短哈希解析：已有完整归档 ID 先匹配，之后才考虑至少十二位十六进制前缀。多个候选内容真正相同可以作为别名处理；如果相同前缀指向不同文本，工具必须要求更长前缀，不能按列表顺序随便返回其中一条。',
  '控制结果保护：恢复工具返回的 JSON 自带控制结果标识。这个标识帮助请求钩子区分新产生的查询输出与普通源码，避免查询结果中的旧标记在下一请求又被折叠，形成不断读取、不断消失的循环。',
  '导出与查阅分开：paste 创建新文件使用排他写入，已有文件或符号链接不应被覆盖。导出成功并不表示后续模型必须继续看到整份原文，所以改变 keep 状态应当由显式参数或恢复操作表达，不能隐含在导出行为里。',
  '统计的时间点：请求钩子完成替换只证明投影和归档成功，不能证明供应商接受了请求。成功、失败及无法匹配实际请求的回执应分别统计；同一回执被重复处理时，只能累计一次，不能让测试误报更多节省。',
  '原始请求重放：宿主可能每次发送完整原历史，也可能把前次折叠投影继续传回。两条路径都要保留引用对应的 scope；已经折叠的视图不能因为再次审查收益门槛就失去恢复定位信息。',
  '状态可读性：用户只是想知道有没有实际缩短时，不必得到所有历史计数器。默认状态应显示本次原因、条目数量和请求净差；完整统计保留给显式详情查询，避免为了诊断节省量又制造大段重复输出。',
  '空闲路径：没有合法标记并且没有既有引用时，插件没有任何内容要替换。未知容量的动态预算只会告诉模型两个 unknown 并消耗额外字节。此时原样放行可以直接消除无用的提示成本。',
  '已排除的改变：本轮不修改系统指令、不选取用户内容、不处理图片或签名推理、不从未知 JSON 里猜测源码、不删除归档来满足容量。磁盘写入失败或恢复入口不可用时应保留原始请求。',
  '验收记录范围：这里的输入由脚本直接重放，成功回执由测试驱动，不代表已经调用供应商或模型。可验证的是请求投影、归档完整性、分页上限和状态变化；任务正确率、延迟和真实费用需要另外测量。',
].join('\n\n');
const sourceText = await readFile(join(scriptRoot, 'src/source.ts'), 'utf8');
const sourceHash = storage.digest(sourceText);

function request(messages: Message[]): Body {
  return {
    model: 'offline-replay',
    tools: [
      { type: 'function', function: { name: 'context_folding', description: descriptor.description, parameters: descriptor.args } },
      { type: 'function', function: { name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
      { type: 'function', function: { name: 'exec', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
    ],
    messages: [{ role: 'system', content: userConstraint }, ...messages],
  };
}

interface Step {
  request: string;
  inputTokensEstimated: number;
  outputTokensEstimated: number;
  requestReductionEstimated: number;
  recoveryHistoryOverheadEstimated: number;
  netAfterRecoveryOverheadEstimated: number;
  netIncludingPluginToolEstimated: number;
  entries: number;
  foldedEntries: number;
  visibleReferences: number;
  decision: unknown;
}

async function isolated<T>(name: string, run: (env: {
  scope: string;
  step: (label: string, input: Body, originalWithoutRecovery?: Body) => Promise<{ output: Body; row: Step }>;
  snapshot: () => Promise<Snapshot | undefined>;
}) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'context-folding-replay-'));
  const previous = { state: process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR, config: process.env.XDG_CONFIG_HOME };
  process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = join(directory, 'state');
  process.env.XDG_CONFIG_HOME = join(directory, 'config');
  await mkdir(join(directory, '.git'));
  const store = new storage.Store();
  const scope = await store.scopeFor(JSON.stringify([name, '', '', directory]));
  const snapshot = async (): Promise<Snapshot | undefined> => {
    try { return await store.transaction(scope, false, 64 * 1024 * 1024, value => value); }
    catch (error) {
      if (error instanceof Error && error.message === 'Unknown context scope') return;
      throw error;
    }
  };
  try {
    return await run({ scope, snapshot, step: async (label, input, originalWithoutRecovery = input) => {
      const context = { protocol: 'chat', model: 'offline-replay', session: name, cwd: directory, state: {} };
      const untouched = structuredClone(input);
      const output = await hooks.onRequest(input, context) as Body;
      assert.deepEqual(input, untouched, 'hook must not mutate the client history');
      await hooks.onResponse({}, { ...context, success: true, request: output });
      const beforeMessages = input.messages as Message[];
      const afterMessages = output.messages as Message[];
      assert.deepEqual(afterMessages.filter(value => value.role === 'user'), beforeMessages.filter(value => value.role === 'user'));
      assert.ok(afterMessages.some(value => value.role === 'system' && value.content === userConstraint));
      assert.deepEqual(afterMessages.flatMap(value => value.tool_calls ?? []), beforeMessages.flatMap(value => value.tool_calls ?? []));
      assert.deepEqual(afterMessages.filter(value => value.role === 'tool').map(value => value.tool_call_id),
        beforeMessages.filter(value => value.role === 'tool').map(value => value.tool_call_id));
      for (const message of beforeMessages) if (message.content?.includes(conclusion)) {
        assert.ok(afterMessages.some(value => value.content?.includes(conclusion)), 'keep the explicit conclusion');
      }
      const state = await snapshot();
      const inputTokensEstimated = tokenEstimate(input);
      const outputTokensEstimated = tokenEstimate(output);
      const originalTokensEstimated = tokenEstimate(originalWithoutRecovery);
      const withoutPluginTool = { ...originalWithoutRecovery, tools: (originalWithoutRecovery.tools as { function: { name: string } }[])
        .filter(value => value.function.name !== 'context_folding') };
      const visibleReferences = protocol.extractSpans(output, 'chat').filter(span => span.activityReason !== 'plugin-control')
        .reduce((count, span) => count + (span.text.match(/\[\[cf:v2:[a-f0-9]{12,64}\]\]/g)?.length ?? 0), 0);
      return { output, row: {
        request: label, inputTokensEstimated, outputTokensEstimated,
        requestReductionEstimated: inputTokensEstimated - outputTokensEstimated,
        recoveryHistoryOverheadEstimated: inputTokensEstimated - originalTokensEstimated,
        netAfterRecoveryOverheadEstimated: originalTokensEstimated - outputTokensEstimated,
        netIncludingPluginToolEstimated: tokenEstimate(withoutPluginTool) - outputTokensEstimated,
        entries: state?.entries.length ?? 0,
        foldedEntries: state?.entries.filter(entry => entry.folded !== undefined).length ?? 0,
        visibleReferences, decision: state?.decision ?? null,
      } };
    } });
  } finally {
    if (previous.state === undefined) delete process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
    else process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = previous.state;
    if (previous.config === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous.config;
    await rm(directory, { recursive: true, force: true });
  }
}

const summarize = (steps: Step[]) => ({
  steps,
  cumulativeRequestReductionEstimated: steps.reduce((sum, step) => sum + step.requestReductionEstimated, 0),
  cumulativeNetAfterRecoveryOverheadEstimated: steps.reduce((sum, step) => sum + step.netAfterRecoveryOverheadEstimated, 0),
  cumulativeNetIncludingToolAndRecoveryEstimated: steps.reduce((sum, step) => sum + step.netIncludingPluginToolEstimated, 0),
});

const idle = await isolated('idle', async env => {
  const messages: Message[] = [{ role: 'user', content: '继续检查文件来源，不需要额外的演示。' }];
  const steps: Step[] = [];
  for (let number = 1; number <= 5; number++) {
    const { row } = await env.step(`idle-${number}`, request(messages));
    steps.push(row);
    if (expectImproved) assert.equal(row.requestReductionEstimated, 0, 'idle default must have no dynamic prompt cost');
    messages.push({ role: 'assistant', content: `已检查普通结果 ${number}，要求保持不变。` }, { role: 'user', content: `继续步骤 ${number + 1}。` });
  }
  return summarize(steps);
});

const shortDemo = await isolated('short-demo', async env => {
  const messages: Message[] = [
    { role: 'user', content: '试试效果。' },
    { role: 'assistant', content: marked('demo-workflow', '临时体验笔记：先记录一段过程，再用同名结束标记闭合；原文应能通过哈希引用恢复。') },
    { role: 'assistant', content: marked('live-demo', '临时体验记录：下一次请求应把这段过程收成哈希引用；之后用 read 验证能否恢复原文。') },
    { role: 'user', content: '检查上一轮的标记。' },
  ];
  const steps: Step[] = [];
  for (let number = 1; number <= 3; number++) {
    const { row } = await env.step(`short-${number}`, request(messages));
    steps.push(row);
    if (expectImproved) {
      assert.equal(row.entries, 0, 'tiny demonstration text must not enter the archive');
      assert.equal(row.visibleReferences, 0);
      assert.equal(row.requestReductionEstimated, 0);
    }
    messages.push({ role: 'user', content: `继续检查 ${number}。` });
  }
  return summarize(steps);
});

const longWorkflow = await isolated('source-review', async env => {
  const messages: Message[] = [
    { role: 'user', content: '审阅源码注释识别和恢复语义，保持结论可见。' },
    { role: 'assistant', content: '读取完整源文件。', tool_calls: [
      { id: 'read-source', type: 'function', function: { name: 'read', arguments: '{"path":"src/source.ts"}' } },
    ] },
    { role: 'tool', tool_call_id: 'read-source', content: sourceText },
    { role: 'assistant', content: marked('completed-source-review', reviewNotes) + '\n\n' + conclusion },
    { role: 'assistant', content: '检查相关测试。', tool_calls: [
      { id: 'run-tests', type: 'function', function: { name: 'exec', arguments: '{"command":"bun test test/source-provenance.test.ts"}' } },
    ] },
    { role: 'tool', tool_call_id: 'run-tests', content: 'Fixture only: source-provenance checks completed; no external command was run by this replay.' },
    { role: 'user', content: '继续检查恢复接口。' },
  ];
  const steps: Step[] = [];
  let lastOutput: Body | undefined;
  for (let number = 1; number <= 4; number++) {
    const result = await env.step(`work-${number}`, request(messages));
    steps.push(result.row);
    lastOutput = result.output;
    if (expectImproved && number >= 2) {
      assert.ok(result.row.requestReductionEstimated >= 256, 'completed real-sized content must clear the whole-request guard');
      assert.ok(result.row.visibleReferences >= 2, 'both annotated review and verified source should fold');
    }
    messages.push({ role: 'assistant', content: `检查步骤 ${number} 已完成，下一步只需核对恢复边界。` },
      { role: 'user', content: `保留结论，推进步骤 ${number + 1}。` });
  }
  assert.ok(lastOutput);
  const archived = await env.snapshot();
  const noteHash = storage.digest(reviewNotes);
  const noteEntry = archived?.entries.find(entry => entry.annotation?.sha256 === noteHash);
  assert.ok(noteEntry, 'the full review notes must be recoverable');
  assert.equal(noteEntry.text, reviewNotes);
  assert.ok(archived?.entries.some(entry => entry.role === 'tool'), 'the verified source must be archived');

  const readArgs = { action: 'read', scope: env.scope, id: noteHash.slice(0, 12) };
  const readRaw = await tool.execute(readArgs);
  const readResult = JSON.parse(readRaw) as { error?: string; text: string; kept: boolean; sha256: string; nextOffset: number | null; totalChars: number };
  assert.equal(readResult.error, undefined);
  assert.equal(readResult.sha256, noteHash);
  assert.equal(readResult.text, reviewNotes.slice(0, readResult.text.length));
  if (expectImproved) {
    assert.equal(readResult.kept, false, 'ordinary page lookup must not permanently restore history');
    assert.ok(readResult.text.length <= 2000);
    assert.ok(readResult.nextOffset !== null, 'the default lookup is only one page');
  }
  const recoveryMessages: Message[] = [
    { role: 'assistant', content: '回查这一段的开头。', tool_calls: [
      { id: 'lookup-review', type: 'function', function: { name: 'context_folding', arguments: JSON.stringify(readArgs) } },
    ] },
    { role: 'tool', tool_call_id: 'lookup-review', content: readRaw },
  ];
  const originalAfterRead = request(messages);
  const withRead = request([...messages, ...recoveryMessages]);
  const afterRead = await env.step('work-after-default-read', withRead, originalAfterRead);
  steps.push(afterRead.row);
  const noteVisible = protocol.extractSpans(afterRead.output, 'chat').some(span => span.role === 'assistant' && span.text.includes(reviewNotes));
  if (expectImproved) {
    assert.equal(noteVisible, false);
    assert.ok(afterRead.row.netAfterRecoveryOverheadEstimated > 0, 'the workflow must still be smaller after including the page and tool call');
  }

  // A full exact read validates recovery separately; it is not hidden in workflow totals.
  const validationRaw = await tool.execute({ ...readArgs, peek: true, limit: 24000 });
  const validation = JSON.parse(validationRaw) as { text: string; sha256: string };
  assert.equal(validation.text, reviewNotes);
  assert.equal(validation.sha256, noteHash);
  let validationTokensEstimated = tokenEstimate(validationRaw);
  let validatedEntries = 1;
  for (const entry of archived!.entries.filter(entry => entry.role === 'tool')) {
    assert.ok(sourceText.includes(entry.text), 'the archived source must match the actual fixture bytes');
    const recoveredSourceRaw = await tool.execute({ action: 'read', scope: env.scope, id: entry.id, peek: true, limit: 24000 });
    const recoveredSource = JSON.parse(recoveredSourceRaw) as { text: string; sha256: string };
    assert.equal(recoveredSource.text, entry.text);
    assert.equal(recoveredSource.sha256, storage.digest(entry.text));
    validationTokensEstimated += tokenEstimate(recoveredSourceRaw);
    validatedEntries++;
  }

  const restoreArgs = supportsRestore
    ? { action: 'restore', scope: env.scope, id: noteHash.slice(0, 12), limit: 120 }
    : { action: 'read', scope: env.scope, id: noteHash.slice(0, 12), limit: 120, peek: false };
  const restoreRaw = await tool.execute(restoreArgs);
  const restoreResult = JSON.parse(restoreRaw) as { error?: string; kept: boolean };
  assert.equal(restoreResult.error, undefined);
  assert.equal(restoreResult.kept, true);
  const restoreMessages: Message[] = [
    ...recoveryMessages,
    { role: 'assistant', content: '接下来需要持续查看完整审阅记录。', tool_calls: [
      { id: 'restore-review', type: 'function', function: { name: 'context_folding', arguments: JSON.stringify(restoreArgs) } },
    ] },
    { role: 'tool', tool_call_id: 'restore-review', content: restoreRaw },
  ];
  const afterRestore = await env.step('work-after-explicit-restore', request([...messages, ...restoreMessages]), request(messages));
  steps.push(afterRestore.row);
  assert.ok(protocol.extractSpans(afterRestore.output, 'chat').some(span => span.role === 'assistant' && span.text.includes(reviewNotes)));
  const final = await env.snapshot();
  assert.equal(final?.entries.find(entry => entry.annotation?.sha256 === noteHash)?.mark.disposition, 'keep');
  const readTextTokens = tokenEstimate(readResult.text);
  return {
    ...summarize(steps),
    noteBytes: textBytes(reviewNotes), noteChars: reviewNotes.length,
    defaultRead: {
      kept: readResult.kept, returnedChars: readResult.text.length, nextOffset: readResult.nextOffset,
      resultTokensEstimated: tokenEstimate(readRaw), textTokensEstimated: readTextTokens,
      metadataAndSerializationTokensEstimated: tokenEstimate(readRaw) - readTextTokens,
      oldNoteVisibleAfterRead: noteVisible,
    },
    explicitRestore: { action: restoreArgs.action, kept: true },
    exactRecoveryValidation: {
      matched: true, validatedEntries, separateFromWorkflowTotals: true, resultTokensEstimated: validationTokensEstimated,
      noteHash,
    },
    metrics: final?.metrics,
  };
});

process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  kind: 'offline-chat-request-replay',
  basis: 'ceil(JSON UTF-8 bytes / 4); complete request including actual tool definitions',
  modelCalled: false,
  measuredBillSaving: null,
  taskQualityMeasured: false,
  improvedAssertions: expectImproved,
  sourceFixture: { path: 'src/source.ts', sha256: sourceHash, bytes: textBytes(sourceText) },
  pluginToolDefinitionTokensEstimated: tokenEstimate({ name: 'context_folding', description: descriptor.description, parameters: descriptor.args }),
  idle, shortDemo, longWorkflow,
}, null, 2) + '\n');
