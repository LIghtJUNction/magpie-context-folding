<p align="center">
  <img src="docs/assets/logo.png" alt="magpie-context-folding 折纸喜鹊 Logo" width="176">
</p>

<div align="center">
  <h1>magpie-context-folding</h1>
  <p><strong>让 Agent 主动收起已经完成的长过程，同时保留可精确恢复的原文。</strong></p>
  <p>主动整理 · 显式标记 · 持久归档 · 内容哈希 · 按需恢复</p>

  [![Release](https://img.shields.io/github/v/release/LIghtJUNction/magpie-context-folding?style=flat-square)](https://github.com/LIghtJUNction/magpie-context-folding/releases/latest)
  [![npm](https://img.shields.io/npm/v/magpie-context-folding?style=flat-square&logo=npm)](https://www.npmjs.com/package/magpie-context-folding)
  [![License](https://img.shields.io/github/license/LIghtJUNction/magpie-context-folding?style=flat-square)](LICENSE)

  [项目理念](#项目理念主动式上下文折叠术) · [插件与技能快速开始](#插件与技能快速开始) · [安装](#安装) · [一分钟理解](#一分钟理解) · [恢复](#恢复原文) · [独立核心](#独立文本核心-ctxf) · [协议](docs/annotation-protocol.md)
</div>

## 项目理念：主动式上下文折叠术

长任务会不断积累调查证据、方案比较、复现过程和验证说明。这些内容值得留存，但阶段完成后，后续工作通常只需要结论、约束和下一步。本项目把这种取舍交给正在执行任务的 Agent：在工作过程中主动组织可回查的长正文，待一个完整问题得到验证后闭合标记，由插件归档并折叠。

我们把这种工作方法称为**主动式上下文折叠术**。它是一种持续整理工作记录的习惯，不必等到上下文耗尽、被动压缩时才开始。Agent 负责判断哪些细节已经可以收起，插件负责保存精确原文与生成恢复入口，后续需要某条证据时再读取。

每个工作段都应留下能独立推进任务的可见信息：

- **外面留当前状态**：主要结论、有效要求与授权、关键约束、未解决的失败、必要文件位置和下一步。即使折叠正文不可见，任务也能继续。
- **里面放可回查的细节**：实际需要呈现的证据、复现步骤、方案比较、修改依据和验证解释。同一问题可以跨多次工具调用保持一个工作段，结果验证后再闭合；工具调用和普通工具结果仍保持原结构，不因被标记包围就自动折叠。
- **需要时精确恢复**：插件先持久保存完整正文，再替换可折叠部分，提供真实哈希与文件路径。后续按实际路径读原文，或用 CLI 搜索和读取归档。

折叠不是把尚未解决的问题藏起来，也不应把几句进度播报套进空框。短回答保持简短；长任务按完整问题和已完成阶段组织。需要始终可见的局部内容可以放入箭头保留区，标记教程也用保留区保护，避免示例被当作指令。

**标记表达折叠意图，后端决定是否真正完成。** 技能指导 Agent 写好工作记录；Magpie 插件执行可逆替换。没有兼容后端时，标记仍只是文本。仅看到标记不能证明归档成功，更不能证明节省了多少 token、缓存或费用；这些效果需要实际请求与提供方用量验证。插件改变的是发送给模型的请求视图，客户端历史和源文件保持原样。

## 插件与技能快速开始

> **必须先安装并启用 `magpie-context-folding` 插件，下面的技能才会在 Magpie 请求中产生实际折叠。** 技能只指导 Agent 编写标记；真正保存原文、替换正文和提供恢复信息的是插件。只安装技能、只写标记，不会自动归档或节省上下文。

### 1. 安装 Magpie 插件

在已安装 Magpie 的环境中执行：

```bash
magpie plugin add npm:magpie-context-folding@0.6.3
```

确保 Agent 的模型请求经过已加载此插件的 Magpie。折叠不依赖工具名、命名空间或 shell 声明；原文先保存到归档，再提供绝对路径和 CLI 恢复信息。当前请求没有读取工具时，可稍后通过宿主文件工具或本地 CLI 恢复。保留已有归档，不要同时加载 npm 包和同一插件的本地源码副本。开发版安装见[安装](#安装)。

### 2. 安装 context-folding 技能

以 Codex 为例，将本仓库的 [SKILL.md](.agents/skills/context-folding/SKILL.md) 保存到 `~/.codex/skills/context-folding/SKILL.md`。已经克隆仓库时，在仓库根目录执行：

```bash
mkdir -p ~/.codex/skills/context-folding
cp .agents/skills/context-folding/SKILL.md ~/.codex/skills/context-folding/SKILL.md
```

如果该路径已有自定义技能，请先比较内容再更新。安装后新开 Codex 会话，确认技能列表中出现 `context-folding`。其他支持 `SKILL.md` 的 Agent 可将同一技能放入其技能目录；实际折叠仍要求请求经过上述 Magpie 插件。

### 3. 在任务中使用技能

在 Codex 中明确调用，例如：

```text
$context-folding 请审查这个项目的代码，按阶段折叠已完成的排查细节，并把发现与下一步留在标记外。
```

只有实际需要输出较长证据、比较或解释时才标记；不把进度播报和工具调用套进空框。下面是缩短示例，外围箭头保护教程本身，内部箭头演示局部保留：

→ 不折叠开始
```text
发现：重试可能重复记账。
>> 检查重复扣款的证据 <<
两次请求使用同一 request_id。第一次扣款已提交，随后连接中断。
重试再次调用 debit()，没有检查请求是否完成，又写入一笔扣款。
→ 不折叠开始
保留：request_id=42；回归测试尚未通过。
← 不折叠结束
这里继续写实际需要呈现的详细证据。
<< 同一请求产生两笔扣款 >>
下一步：添加去重并验证。
```
← 不折叠结束

标记闭合后，插件先按哈希文件名保存完整原文，再把可折叠部分显示为 `...`；箭头保留区原样留在中间。折叠元数据提供真实 `path` 和 `hash`，可直接读文件。保留区内的示例标记不再被解释为折叠指令；保留区可嵌套。普通工具结果不会因为位于标记之间就一并折叠。

仅看到起止标记不代表已经折叠；未闭合、错配或归档失败时保留原文；已闭合的有效标记不受长度或净收益门槛限制。新语法和目录 CLI 属于当前 Magpie 插件；独立 Python `ctxf` 的接口另见下文。

## 0.6.3：修复前置保留区的重复归档

折叠正文以前置保留区开头时，重放保持原有恢复路径与哈希，不再重复归档或累加折叠计数。嵌套父块也能正确引用这类投影。详见 [发布说明](docs/release-0.6.3.md)。

## 0.6.2：闭合标记直接折叠

有效标记闭合并成功归档后直接折叠，取消单块 token 门槛与整批净收益检查。旧 `min_savings_tokens` / `minSavingsTokens` 配置兼容保留但不再影响折叠。已有归档复用时同步文件和目录；配额拒绝、版本冲突或提交失败不会发布未提交的原文。详见 [发布说明](docs/release-0.6.2.md)。

## 0.6.0：局部保留与极简目录 CLI

折叠块里可以用箭头保留当前仍需要的部分，其他正文显示为 `...`。完整原文以哈希文件名保存，CLI 仅负责归档目录的统计、排序列出、搜索、读取与清理。旧 CLI 的 scope、层级、恢复状态、状态栏及报告命令已移除；迁移说明和验收命令见 [0.6.0 发布说明](docs/release-0.6.0.md)。

## 一分钟理解

它本质上不是摘要模型，而是一段**可逆文本替换**：

```text
Agent 写出阶段结论
      ↓
用注释标记包住长过程
      ↓
插件先把原文持久化
      ↓
标记闭合，直接折叠
      ↓
把正文替换成 ...，箭头保留区保持原样
      ↓
需要时直接读取 path 指向的哈希文件
```

示例：

```text
保留结论：下一步检查 router.ts 的超时分支；失败重试仍未验证。
<!-- @context-fold begin route-analysis-details -->
这里是较长的排查、比较、日志和推导过程。
<!-- @context-fold end route-analysis-details -->
```

默认首次完整观察到有效闭合标记时，正文即被折叠；可配置请求周期延迟。兼容的旧标记示例：

```text
<!-- @context-fold begin route-analysis-details -->
[[cf:v2:4db3a91c6e2f]]
<!-- @context-fold end route-analysis-details -->
```

插件不猜哪些内容“不重要”。未标记、未闭合或错配的内容保持原样；已闭合的有效标记直接折叠。

## 它解决什么问题

长任务里，历史通常同时包含两种信息：

- **仍需要每轮携带的状态**：结论、约束、失败、待办、当前文件和下一步；
- **偶尔才需要回查的证据**：长日志、探索过程、大段源码、重复比较和已经结束的推导。

折叠协议要求 Agent 先在标记外留下可独立理解的状态，再把第二类内容包起来。这样后续请求仍看得到任务状态，需要证据时又能从本地归档精确恢复，而不是依赖不可逆摘要。

## 0.5.4：持续注入主动折叠规则

从首个短任务起，每次可恢复请求都带一份主动管理规则，不再因连续无折叠而撤掉。长评审、长报告中值得回查的长正文使用起止标记；短回答与用户明确要求的 JSON、纯代码、精确输出保持原格式。插件计算收益并生成元数据，模型不编造 hash/path。

真实模型单任务试验中，用户没有提及折叠，模型主动生成完整标记，下一轮正文从 9,555 B 变为 1,121 B，文件原文校验通过；“只输出 OK”仍得到 `OK`。方法、初次未遵循的结果和验证范围见[发布说明](docs/release-0.5.4.md)及[原始回执](docs/benchmarks/proactive-guidance-live-0.5.4.json)。

## 0.5.3：通用起止标记与原文文件

`>> 开始缘由 <<` 打开，`<< 结束结果 >>` 关闭；两端文案可以不同，折叠时原样保留。中间正文变为 `line`、`hash`、`tokens`（估算）、`tokens_method`、`path` 和恢复引用。`path` 为规范绝对路径，指向 `archive/<完整 SHA-256>.txt`，任何 Agent 或工具均可直接读取精确 UTF-8 原文。

支持嵌套、跨 Assistant 文本、用户边界和重复投影；未闭合或错配区域保持原文；有效闭合标记不受净收益门槛限制。先原子保存文件并校验内容，再发布折叠视图。Magpie 插件与独立 `ctxf` 使用同一约定，原有源码注释标记继续兼容。安装和验证见[发布说明](docs/release-0.5.3.md)。

## 0.5.2 的可验证变化

此前 `0.5.2` 还对长源码读取做保守投影：当问题能唯一定位到一个函数时，后续请求只保留该函数和可确认的文件级字面量常量；问题有歧义时继续保留完整源码。被省略的定义仍在归档中，可用 `grep` / `read` 查回。

发布验证记录包括：

- TypeScript 类型检查、构建和 312 项 Bun 测试通过；
- 隔离 Magpie host smoke 中 29/29 请求到达本地合成上游，46,278 字节合成源码可精确恢复；
- 本地合成投影基准中，定向请求为 1,086–1,177 B，完整源码请求为 127,340–127,439 B。

这些数字只证明本地代码路径、序列化字节和恢复行为。它们没有调用真实 Provider，不证明回答质量等价、真实 token、账单节省或任务提速。完整方法和限制见 [基准与质量记录](docs/cost-speed-quality.md)。

## 安装

### Magpie 插件

```bash
magpie plugin add npm:magpie-context-folding@0.6.3
```

保留已有归档，不要同时加载 npm 包和同一插件的本地源码副本。

开发版需要 Bun 1.4+、Node.js 22+ 和 npm：

```bash
git clone https://github.com/LIghtJUNction/magpie-context-folding.git
cd magpie-context-folding
npm ci
npm run check
magpie plugin add "$PWD"
```

Magpie 直接加载 TypeScript 源码，不依赖安装时构建脚本。发布使用 GitHub Actions Trusted Publishing 与 OIDC provenance，不需要长期 npm token。

## 给 Agent 的最小提示

插件在可恢复的每次请求中持续注入一份规则，首次短任务也能收到，不需要等上下文变长或用户提醒：

> 主动管理上下文，有值得回查的长正文时使用标记协议，不等用户要求压缩。开始输出长正文时，独占一行写 `>> 具体起因 <<`，把较长的证据、日志、比较细节放在其中；完成时独占一行写 `<< 已验证结果 >>`，在下一用户回合前闭合。当前结论、约束、失败和下一步保持在外面。不要为了折叠增加冗余内容，不标记短回答、精确格式输出或用户原话。由插件保存原文并生成 hash、path 等字段，不要自行计算或编造。需要旧细节时按实际 path 读取。

开始和结束描述可以不同，应表达该阶段的真实起因与结果。源码继续使用下面的注释语法。

## 源码标记

同一语法可用于源码注释：

```rust
// @context-fold begin parse-options
let options = parse_options(input)?;
validate_options(&options)?;
// @context-fold end parse-options
```

```python
# @context-fold begin parse-options
options = parse_options(source)
validate_options(options)
# @context-fold end parse-options
```

插件只修改发送给模型的视图，不改写原文件。对 Python、JavaScript 和 TypeScript 会尽量排除字符串中的伪标记；遇到无法可靠解析的模板插值、JSX 或复杂语法时，保守地保留完整源码。

完整语法、嵌套、跨消息配对和失败行为见 [注释协议](docs/annotation-protocol.md)。

## 恢复原文与目录管理

直接读取折叠元数据中的绝对 `path` 即可。CLI 只管理包含 `<SHA-256>.txt` 的目录，不需要 scope、会话、层级或数据库：

```bash
magpie-context-folding stats --dir /实际归档目录
magpie-context-folding list --dir /实际归档目录 --sort size --order desc
magpie-context-folding search '要找的文字' --dir /实际归档目录
magpie-context-folding read 实际哈希 --dir /实际归档目录
magpie-context-folding clean --older-than 30 --dir /实际归档目录
magpie-context-folding clean --older-than 30 --dir /实际归档目录 --apply
```

`read` 原样输出完整文件，也可以用 `cat /实际/path.txt`。哈希支持至少 12 位的无歧义前缀。`list` 可按 `name`、`size`、`time` 排序；`stats` 只统计文件数与字节数。`search` 按字面文本匹配，输出路径、行号和文本。`clean` 默认预览，加 `--apply` 才删除，也可直接指定一个哈希；清理会删除对应原文，请只清理不再需要的文件。

省略 `--dir` 时使用 `MAGPIE_CONTEXT_FOLDING_STATE_DIR/archive`，否则使用 XDG 数据目录下的 `magpie-context-folding/archive`。只管理普通哈希 `.txt` 文件，忽略其他文件和符号链接。读取不改变后续折叠状态。原文文件独立于插件内部会话数据库保留；CLI 不再提供 `scope`、`restore`、`meta`、`paste`、状态栏或 HTML 报告命令。

## 独立文本核心 `ctxf`

`context-folding/` 提供独立 Python 包，用于显式文本转换和持久归档，不依赖 Magpie：

```bash
uv tool install ./context-folding
cat notes.txt | ctxf > notes.folded.txt
ctxf fold --language python < module.py > module.folded.txt
```

`ctxf fold` 立即处理已经闭合的合法标记，不等待下一轮请求。它先保存正文，再输出引用；标准输出只包含转换后的文本，诊断写到标准错误。

```bash
ctxf read --scope default --id ACTUAL_SHORT_HASH --restore
```

Python 核心和 Magpie 插件使用不同归档后端，scope 与引用不互通。用生成引用的同一后端恢复。完整说明见 [独立核心文档](context-folding/README.md) 和 [传输协议](context-folding/docs/TRANSPORT.md)。

## 配置

加载顺序：内置默认值 → 全局配置 → 最近的项目配置 → 插件 options。

- 全局：`$XDG_CONFIG_HOME/context-folding/config.toml` 或 `~/.config/context-folding/config.toml`
- 项目：从当前目录向上查找 `.context-folding.toml`，到 Git 根目录停止

```toml
version = 1

[folding]
enabled = true
observe_only = false
delay_requests = 0
max_session_bytes = 67108864
# min_savings_tokens 已兼容保留，不再作为折叠条件

[magpie]
# shell_tool_name 已兼容保留，不再作为折叠前置条件
# recovery_command = "/path/to/magpie-context-folding"
# gateway_timeout_ms = 3000
```

`delay_requests = 1` 表示留出一次完整观察机会；`min_savings_tokens` / `minSavingsTokens` 仅兼容旧配置，不再影响折叠；`max_session_bytes` 是归档容量上限，不是自动折叠阈值。

任何存档失败、容量不足、并发冲突或恢复入口不明确的情况都应保留原文。

## 从 0.3.x 升级

0.5.x 删除了自动模式、经济档位、`mark` 建组、预算注入和自动摘要。旧配置中的下列字段不会被悄悄映射：

```text
mode
threshold_tokens
keep_recent_messages
head_chars
minimum_saving_usd
[policy]
[magpie.accounting]
context_window_tokens
reserve_output_tokens
budget_hints
recovery_tool_name
```

删除这些字段和旧提示词，但保留数据库，以便恢复仍被引用的历史内容。

## 明确边界

- 折叠只处理 Agent 明确标记的 Assistant 文本或可验证的源码读取结果。
- 用户指令、工具参数、普通工具结果、图片和签名推理字段不会被顺带删除。
- 原文先持久化成功，视图才会替换；失败时宁可不折叠。
- 内容哈希标识正文，位置和会话状态另行跟踪；同名标签不会覆盖旧内容。
- 插件不接管客户端默认 compaction，也不能修改供应商保存的隐藏历史。
- 字节减少、估算 token、回答质量和真实费用是四个不同指标。

## 开发验证

```bash
npm ci
npm run check
```

Python 核心在 `context-folding/` 中独立测试。历史基准和旧费用分析保留用于追溯，但不能直接当作 0.5.x 的效果证明。

## License

[MIT](LICENSE)

### 对话起止标记

通用协议及 Magpie、独立 `ctxf` 实现支持用独占一行的 `>> 开始缘由 <<` 打开区域，用 `<< 结束结果 >>` 关闭区域。两端文案可以不同，折叠时原样保留；中间正文归档后替换为 `line`、`hash`、`tokens`（估算）、`path`（规范绝对路径）及 `...`。原文以 `archive/<完整 SHA-256>.txt` 保存，可由任何软件直接读取。完整格式与边界规则见[协议](docs/annotation-protocol.md#折叠与局部保留)。
