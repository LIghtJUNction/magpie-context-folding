<p align="center">
  <img src="docs/assets/logo.png" alt="magpie-context-folding 折纸喜鹊 Logo" width="200" />
</p>

# magpie-context-folding

**Agent 用一对注释圈出以后可以收起的内容；插件保存原文，等一个请求周期，再把它换成带短哈希的引用。**

0.5.0 的折叠由 Agent 写出的标记请求，并受最小节省量等条件约束。没有智力、平衡、经济档位，也不需要先列目录、再调用 `mark`。未标记的内容保持完整。

**本文描述 0.5.0 release。** 旧版测试与费用分析是历史材料，不能作为新实现的效果证明。

## 文本管道：ctxf

独立 Python 核心提供 `ctxf` CLI，支持折叠操作及持久归档：

```sh
uv tool install ./context-folding

# 默认从 stdin 读 UTF-8 文本，只向 stdout 写折叠后的完整文本。
cat notes.txt | ctxf > notes.folded.txt

# 显式子命令等价；源码可指定语言，以识别真正的注释。
ctxf fold --language python < module.py > module.folded.txt
```

`ctxf fold` 是一次明确的文本转换：立即处理已经闭合的合法注释，不等待后续请求，也不修改宿主延迟配置。无标记、未闭合区域和已有折叠引用保持原样。它先持久保存正文，再输出短引用；标准输出不附加日志、JSON 外壳或换行，错误写到标准错误。`ctxf fold --json` 可查看文本、scope 和引用元数据。

默认归档位于 `$XDG_DATA_HOME/context-folding/archive.sqlite3`，未设置 XDG 时使用 `~/.local/share/context-folding/archive.sqlite3`；`CTXF_STATE` 或 `--state` 可覆盖。默认 scope 为 `default`，可用 `--scope` 分开保存任务。使用同一归档和 scope，`ctxf read --id HASH` 查看折叠视图；把 `HASH` 替换为生成的短哈希。读取不改变折叠状态。

`ctxf mcp` 已移除；可使用 CLI 或 SDK RPC。

`ctxf` 由独立 Python 包提供；根 npm 包的 `magpie-context-folding` 继续管理 Magpie 自己的归档。两个后端的归档和 scope 不互通，恢复引用时使用生成它的后端。详细命令、恢复与传输合同见[独立核心说明](context-folding/README.md)和[传输协议](context-folding/docs/TRANSPORT.md)。

## 怎么用

### 1. 安装 Magpie 插件

安装已发布版本：

```sh
magpie plugin add npm:magpie-context-folding@0.5.0
```

npm 版本通过 GitHub Actions Trusted Publishing 发布：完成 npm 与 GitHub Actions 的 Trusted Publisher 绑定后，推送匹配 `package.json` 版本的 `v*` GitHub Release 会先运行验证，再用 OIDC 发布并生成 provenance，无需长期 npm token 或本机 OTP。

迭代本地源码时，开发检查需要 Bun >= 1.4.0、Node.js >= 22 和 npm：

```sh
npm ci
npm run check
magpie plugin add /absolute/path/magpie-context-folding
```

Magpie 直接加载 TypeScript 源码，不依赖安装时执行构建脚本。根 npm 包只包含 Magpie 插件；[Python 核心及源码适配器](context-folding/README.md)单独安装。

恢复通过宿主已有的 shell 工具调用本地 `magpie-context-folding` CLI。请求必须提供可调用的 shell 工具；无法确认时插件保留原文。若宿主使用不同的 shell 工具名，可设置 `[magpie].shell_tool_name`；如需指定 CLI 命令，可设置 `[magpie].recovery_command`。

### 2. 给 Agent 一段短提示词

插件会自动向请求加入简短指导；也可以按宿主需要补充下面的提示词：

> 主动用折叠标记管理上下文，不要等窗口紧张。每完成一段实质性工作，先在标记外写简明且可独立理解的当前摘要，再紧接着用 `<!-- @context-fold begin task-details -->` 和 `<!-- @context-fold end task-details -->` 包住较长的支撑过程。结论、约束、失败和下一步留在摘要里；摘要必须在细节折叠后仍能说明任务进展。不要一开始打开包住全部工作的总标记。小段和仍在进行的内容不必标记；未闭合的标记不能折叠。闭合后经过一个请求周期，符合净节省条件的内容会保存并折叠。源码使用相同标记和对应语言的注释语法。不要计算哈希；需要原文时，用系统给出的 scope 和短哈希通过 shell 调用本地 CLI。

`LABEL` 是简短名称，例如 `route-analysis`。它帮助 Agent 识别内容，不是唯一编号，不要求手工维护哈希。

### 3. 输出开始标记，完成后输出结束标记

```text
保留结论：下一步检查 router.ts 的超时分支；失败重试仍未验证。下面是支撑这个判断、以后可能需要回查的过程。
<!-- @context-fold begin route-analysis-details -->
这一段是阶段性的排查、比较或推导过程。
可以是一条消息，也可以分布在同一任务轮次的多条 Assistant 普通文本消息里。
<!-- @context-fold end route-analysis-details -->
```

第一次请求观察到完整标记时，正文仍可见。下一次组装请求时，符合节省门槛的正文才替换成 `[[cf:v2:<hash>]]`，两个标记行保留。相同请求的重试不消耗等待周期；没有后台计时器，不会修改正在生成的流式响应。跨消息配对只收起 Assistant 的普通文本切片，每个切片显示同一个引用，避免制造空消息；工具调用及工具结果留在原位置；新的用户消息会截断尚未闭合的范围。

源码用同一核心语法，例如：

```rust
// @context-fold begin parse-options
let options = parse_options(input)?;
validate_options(&options)?;
// @context-fold end parse-options
```

Python 用 `#`，JavaScript/TypeScript 用 `//`，也可使用对应语言的完整块注释。折叠只改变发送给模型的视图，原文件不改写。Magpie 请求钩子会处理能够核实来源的单一文本源码读取结果；普通工具 JSON、部分读取及无法确认格式的结果保持原样。其他宿主需要接入[源码适配器](context-folding/README.md#source-annotations-and-compact-reads)。

网关对 Python 和 JavaScript/TypeScript 使用保守词法过滤，排除字符串里的伪标记；遇到 f-string、无法可靠区分的模板插值或 JSX 等复杂结构时保留该份源码。独立 Python 核心使用 Python tokenizer 和可选的 JS/TS Tree-sitter 语法分析，能力范围不同。其他语言仍使用整行字面协议，不能保证排除多行字符串中的伪标记。

## 短哈希与恢复

系统按实际折叠正文的 UTF-8 字节计算 SHA-256，引用为 `[[cf:v2:<hash>]]`，通常显示前 12 位，遇到冲突时延长。外层标记不计入正文；正文末尾的一个物理换行保留在引用外，以便精确恢复。哈希随正文变化，同名标记的不同内容不会指向同一个快照。旧引用仍恢复当时的原文，不会偷偷改成磁盘上的最新文件。

从折叠引用取出实际短哈希，使用请求提示中的 scope：

```sh
magpie-context-folding read --scope 'CURRENT_SCOPE' --id 'ACTUAL_SHORT_HASH' --restore
```

将占位内容替换为实际值。`--restore` 输出完整原文，并保护所选子树及其外层折叠；普通 `read` 查看当前视图，不改变折叠状态，嵌套子项可能仍是引用。可用 `--all` 查看完整原文而不改变折叠状态，`--json` 返回哈希和分页信息。原文只作为资料返回，不执行其中的旧命令。

其余工具用于按需查找和维护，不是每轮必走的流程：

| Action | 用途 |
| --- | --- |
| `read` | 按短哈希或已有归档 ID 读取视图或原文，支持分页和显式恢复。 |
| `list` | 找回忘记的引用，或检索旧归档。 |
| `grep` / `meta` | 搜索归档内容或查看节点元数据。 |
| `paste` | 将选定视图写到宿主上的新文件，拒绝覆盖现有文件。 |
| `status` | 检查当前会话归档与最近处理情况。 |
| `stats` | 查看累计折叠和恢复统计；token 数是估算。 |
| `forget` | 清理已经恢复、没有仍在使用的折叠引用的会话归档。 |

根插件的分页偏移按 JavaScript UTF-16 单元计数，直接使用 `nextOffset`。Python 核心使用 Unicode 码点偏移，二者不能混用。scope 是会话恢复能力值，不应转交其他会话。旧归档的原文、历史层和分组清单仍可读取；0.5.0 不再创建旧式摘要层或通过 `mark` 建组。

## 预算

本项目不管理上下文窗口或输出预算，也不注入预算提示。折叠只处理 Agent 标记的内容，并检查估算节省量。

## 配置

按内置默认值、全局配置、最近的项目配置、插件 options 顺序覆盖。全局文件为 `$XDG_CONFIG_HOME/context-folding/config.toml` 或 `~/.config/context-folding/config.toml`；项目文件为 `.context-folding.toml`，向上搜索到 Git 根目录即止。

```toml
version = 1

[folding]
enabled = true
delay_requests = 1
max_session_bytes = 67108864
min_savings_tokens = 256

[magpie]
# shell_tool_name = "shell"
# recovery_command = "/path/to/magpie-context-folding"
# gateway_timeout_ms = 3000
```

插件 options 使用对应 camelCase：`delayRequests`、`maxSessionBytes`、`minSavingsTokens`、`shellToolName`、`recoveryCommand`、`gatewayTimeoutMs`。`delay_requests = 0` 表示在首次完整观察到闭合标记的请求中折叠；默认值 1 留出一次完整观察机会。`min_savings_tokens` 是估算节省门槛，默认 256。

`max_session_bytes` 是归档容量上限，不是折叠阈值。存档失败、容量不足、并发状态冲突或无法确认恢复入口时，保留原文。默认状态目录为 `$XDG_DATA_HOME/magpie-context-folding` 或 `~/.local/share/magpie-context-folding`，可通过 `MAGPIE_CONTEXT_FOLDING_STATE_DIR` 指定。

## 从 0.3.x 升级

删除配置中的 `mode`、`threshold_tokens`、`keep_recent_messages`、`head_chars`、`minimum_saving_usd`、`[policy]` 和 `[magpie.accounting]`，以及已移除的预算设置 `context_window_tokens`、`reserve_output_tokens`、`budget_hints` 和 `recovery_tool_name`。这些设置不会静默映射成另一种自动策略；旧配置会给出迁移错误。

删除 Agent 提示词里关于 `mark`、三档切换、自动摘要和成本批准的操作要求，换成上面的标记说明。保留旧数据库，以便恢复仍在引用的内容；不要靠删除归档解决配置错误。

## 机制边界

- 正确匹配的区域可以嵌套；未闭合或错配区域保持原文。孤立结束标记保持字面文本。普通句子中的示例字符串不是标记，标记必须独占一行。
- 未标记内容、用户指令、工具调用参数、普通工具结果、图片及签名推理字段不会被此协议顺带删除。
- 内容哈希和出现位置分别跟踪。同一份内容刚被再次读取，不能仅因旧副本曾折叠就立即藏起。
- 先持久保存原文，成功后才替换视图；归档引用是恢复入口，不是授权凭据。
- 插件修改本次发给模型的请求，不接管客户端默认 compaction，也无法修改供应商保存的隐藏历史。需要当前完整、可编辑的历史才能应用折叠。
- 字节减少、估算 token 减少、任务质量和真实账单节省是不同指标。本次源码重构不继承旧策略的性能或费用结论。

详细协议见 [注释协议](docs/annotation-protocol.md)，并发恢复见 [恢复一致性](docs/recovery-consistency.md)。测试使用 `npm run check`；源码适配器与 SDK 的验证命令见[子项目说明](context-folding/README.md)。

## 可复现基准

本项目公布确定性查询微基准与已安装 npm 包的隔离 Magpie HTTP smoke。两者回答不同问题：微基准测内存中归档树查询；host smoke 验证已安装插件在真实 Magpie/Bun gateway 请求路径中的折叠与恢复接线。Smoke 使用本地合成上游，不调用外部模型，也不代表模型质量或真实账单节省。

### 已安装插件的 Magpie gateway smoke

测试脚本从 Magpie 本机 npm 插件安装目录读取 `magpie-context-folding@0.5.0`，复制到临时隔离目录，在 bubblewrap、临时 HOME/XDG 和独立 localhost 合成模型下启动真实 Magpie host。它发送 18 个 Chat Completions 请求，并检查闭合标记延迟、重试、折叠引用、系统指导、CLI 分页读取、文件导出、显式恢复、会话隔离和源码只读等行为。逐步断言见 [`scripts/host-smoke.py`](scripts/host-smoke.py) 与 [`scripts/installed-package-smoke.py`](scripts/installed-package-smoke.py)。

需要 Linux、bubblewrap、Magpie、Bun 1.4+ 和已安装的 npm 插件。默认读取 `~/.config/magpie/plugins/node_modules/magpie-context-folding`；也可通过 `--package` 指定安装目录。测试不修改现有 Magpie 插件配置或当前 gateway，不连接供应商模型。

```sh
npm ci
npm run test:host:installed
# 非默认安装位置：
npm run test:host:installed -- --package /absolute/path/to/magpie-context-folding
```

2026-10-28，本机 Magpie 0.1.1850、Bun 1.4.0、npm 包完整性 `sha512-fgL1gijaNu5BrAA145bkrDssiOj6rkCjuCOSi/P6BOKRBH3J+4D8ZAStTbosmrftfNFGxbe1ctlLkI9vpdYK1Q==` 下，已安装包的隔离 host smoke 通过：18/18 请求到达合成上游，响应 hook 成功 18 次，失败/未验证为 0。46,278 UTF-8 字节的 Unicode/emoji/CRLF 原文经分页读取和 `--restore` 后逐字节一致；包括文件导出、会话隔离、重试宽限、源码注释折叠和源文件不变在内的 18 项检查通过。

同一条已发生请求轨迹中，未折叠请求估算为 14,377，折叠请求估算为 2,624（按 JSON UTF-8 字节数除以 4，约减少 81.8%）。这是请求序列化大小估算，不是供应商 tokenizer 用量、反事实完整历史比较或账单节省。机器回执见 [`docs/benchmarks/host-smoke-npm-0.5.0-2026-10-28.json`](docs/benchmarks/host-smoke-npm-0.5.0-2026-10-28.json)。

### 归档树查询微基准

从仓库根目录运行：

```sh
npm ci
npm run bench:tree
```

脚本从 Git HEAD 加载 `src/tree.ts`，与工作树版本比较；使用相同的 3,000 个叶节点、无命中查询，交替执行 browse/grep 各五轮，并断言输出相同。结果包含运行时、源码 SHA-256、每轮耗时及中位数。该微基准在进程内执行，不包含存储 I/O、嵌套节点、命中结果页、Magpie host 或模型时间；它不能单独证明插件端到端提速。

当前 `main` 的 HEAD 与工作树 `src/tree.ts` SHA-256 相同，所以这是同一版本的运行波动检查，不是新旧实现对照。2026-10-28 本机 Bun 1.4.0/Linux x64 的一次五轮结果：

| 查询（3,000 叶节点，无命中） | HEAD 中位数 | 工作树中位数 |
| --- | ---: | ---: |
| browse | 5.80 ms | 5.17 ms |
| grep | 8.07 ms | 5.53 ms |

样本波动明显，不能把这次差值当作性能提升结论。完整原始样本见 [`docs/benchmarks/tree-benchmark-2026-10-28.json`](docs/benchmarks/tree-benchmark-2026-10-28.json)。此前文档记录的约 716→2.26 ms / 835→2.46 ms 属于不同提交和一次历史对照，不是当前版本的可复现基线。

### Harbor 模型 A/B

Harbor runner 可在明确配置端点与模型后比较完整历史和真实注释折叠，命令、结果字段、失败样本处理及成本边界见[基准说明](benchmarks/harbor/README.md)。先运行不调用模型的检查：

```sh
npm run test:harbor
npm run bench:harbor -- validate
npm run bench:harbor -- smoke
```

Smoke 使用公开合成任务及脚本 Agent，只验证接线、评分器正负控制和恢复流程，不产生模型质量分数。真实 A/B 会调用配置的模型服务并产生其相应费用；必须显式设置端点、密钥和模型 ID。当前仓库没有可宣称为 0.5.0 真实模型质量或账单提升的已完成 A/B 结果。

2026-10-29 本机重跑：8/8 trials 完成、0 异常。Oracle 正向控制 2/2 得分 1，nop 负向控制 2/2 得分 0，脚本 Agent 的 baseline 与 folding 共 4/4 得分 1。源码版本为 `716c78e`，本次 Harbor 记录的源码树 SHA-256 为 `75981a48ecdf9187b8ac0c97fd69d3aae4ea4b880a3e3d48c245bcd6ef77d414`。

| 两项合成任务合计（每种模式 10 次请求） | 请求字节（钩子前） | 实际发送字节 | 折叠请求 | CLI 回查 |
| --- | ---: | ---: | ---: | ---: |
| baseline | 91,108 | 91,108 | 0 | 0 |
| folding | 119,824 | 89,408 | 6 | 2 |

folding 模式在自身请求序列中少发送 30,416 字节（25.4%）；折叠后的发送总量比 baseline 少 1,700 字节（1.87%）。这些是本地合成任务的 JSON UTF-8 字节数，不是模型 tokenizer 的 token 数。第一次迭代的细节块太短，两个 folding trial 都未能通过；其中一次记录的三次请求合计从 12,926 字节增至 15,629 字节，额外指导成本超过折叠收益。随后把合成细节从 80 次重复扩到 240 次，并在块外保留状态摘要，完整重跑通过。

这只验证“块外摘要 + 一段已完成细节”的确定性场景，不比较多里程碑层级策略，也不测供应商缓存命中、模型质量或账单。复现命令仍为 `npm run bench:harbor -- smoke`；每次结果保存在本机 `benchmarks/harbor/jobs/`。

### 多里程碑折叠策略回放

用生产 `onRequest` 钩子回放 4 个等长合成里程碑，共 7 次请求，配置 `delayRequests=1`、`minSavingsTokens=256`。四种策略使用相同正文：不折叠、每个里程碑单独折叠、任务总块收尾时一次折叠、总任务外层块加逐个里程碑内层折叠。结束时都保留块外总任务结论。

复现并保存原始记录：

```sh
npm run bench:fold-strategies -- docs/benchmarks/fold-strategy-2026-10-29.json
```

本机 Bun 1.4.0、源码版本 `716c78e` 的结果：

| 策略 | 7 次请求发送字节 | 单次最大前缀失效 | 累计前缀失效 | 平均前缀复用率 |
| --- | ---: | ---: | ---: | ---: |
| 不折叠 | 716,928 | 1 B | 6 B | 99.98% |
| 每个里程碑折叠 | 171,190 | 39,668 B | 157,543 B | 35.93% |
| 任务总块一次折叠 | 560,553 | 157,792 B | 157,797 B | 83.40% |
| 总任务 + 里程碑嵌套折叠 | 170,983 | 39,709 B | 158,588 B | 29.00% |

层级策略相对任务总块一次折叠，发送字节少 69.5%，单次最大前缀变化约小 4 倍；累计前缀失效仍约 158 KB，和一次折叠接近。它把一次大的变化拆成每个里程碑约 39 KB 的变化，任务收尾时再折叠约 1 KB 的摘要与引用结构。相对只折里程碑，外层总块只少发 207 B，却多约 1 KB 累计前缀失效，平均前缀复用率低 6.93 个百分点；因此外层总块应是可选归组，默认逐里程碑折叠即可。不折叠的前缀最稳定，但请求总量最高。

“前缀失效”是相邻请求消息数组序列化后的 UTF-8 公共前缀代理，不等于供应商 cached tokens。该实验使用合成内容，不调用模型；结果适用于比较这四条固定轨迹，不能外推实际缓存命中率、质量或费用。完整逐请求数据、运行指纹见[基准 JSON](docs/benchmarks/fold-strategy-2026-10-29.json)，实现见 [`scripts/fold-strategy-benchmark.ts`](scripts/fold-strategy-benchmark.ts)。

旧的微基准数字之前被描述成“优化前后”；请以本节新增的 commit、源码哈希和复现命令区分历史记录与当前可重跑结果。
