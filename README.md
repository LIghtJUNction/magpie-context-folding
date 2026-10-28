<p align="center">
  <img src="docs/assets/logo.png" alt="magpie-context-folding 折纸喜鹊 Logo" width="200" />
</p>

# magpie-context-folding

**把真实任务中已经完成的长过程存起来，后续只带可回查的短引用；收起后不够省，就保留原文。**

0.4.0 用 Agent 写出的成对标记确定允许折叠的范围。Magpie 插件默认要求一批折叠让完整请求净减少至少 **256 个估算 token**，其中已经扣除引用及恢复提示的开销。未标记的历史不会被自动选中；标记也不会强迫插件执行没有收益的替换。

正常工作不需要先 `status → stats → list`，也不需要为体验插件额外写临时笔记。默认没有折叠引用时不追加动态提示；已知哈希就直接按需 `read`。查阅不会把历史中的原文永久展开，需要保持展开时使用显式 `restore`。

这是正在开发的 **0.4.0 源码版本，未发布到 npm**。本页只描述当前源码；旧版测试与费用分析是历史材料，不能作为新实现的效果证明。

## 文本管道与独立 MCP：ctxf

独立 Python 核心提供 `ctxf`，CLI 和 MCP 共用同一个折叠操作及持久归档：

```sh
uv tool install ./context-folding

# 默认从 stdin 读 UTF-8 文本，只向 stdout 写折叠后的完整文本。
cat notes.txt | ctxf > notes.folded.txt

# 显式子命令等价；源码可指定语言，以识别真正的注释。
ctxf fold --language python < module.py > module.folded.txt

# 启动同一核心的 MCP stdio 服务。
ctxf mcp
```

`ctxf fold` 是一次明确的文本转换：立即处理已经闭合的合法注释，不等待后续请求，也不修改宿主延迟配置。无标记、未闭合区域和已有折叠引用保持原样。它先持久保存正文，再输出短引用；标准输出不附加日志、JSON 外壳或换行，错误写到标准错误。`ctxf fold --json` 可查看文本、scope 和引用元数据。

默认归档位于 `$XDG_DATA_HOME/context-folding/archive.sqlite3`，未设置 XDG 时使用 `~/.local/share/context-folding/archive.sqlite3`；`CTXF_STATE` 或 `--state` 可覆盖。默认 scope 为 `default`，可用 `--scope` 分开保存任务。使用同一归档和 scope，`ctxf read --id HASH --raw` 返回实际哈希对应的完整原文；把 `HASH` 替换为生成的短哈希。默认读取保护原文，`--peek` 只查看。

MCP 客户端可配置：

```json
{
  "mcpServers": {
    "ctxf": {"command": "ctxf", "args": ["mcp"]}
  }
}
```

调用 `context_folding` 的 `fold` action，传入 `scope` 和 `text`，返回 `{scope, text, references}`。宿主消费返回的 `text`；MCP 服务本身不能修改其他工具或既有对话历史。自动处理历史的 Magpie 请求钩子仍使用前文的默认延迟。

`ctxf` 由独立 Python 包提供；根 npm 包的 `magpie-context-folding` 继续管理 Magpie 自己的归档。两个后端的归档和 scope 不互通，恢复引用时使用生成它的后端。**本页后文的 256-token 收益门槛、默认只读 `read` 和 `restore` action 描述 Magpie 插件；Python 的显式 `ctxf fold` 与默认保护式 `ctxf read` 保持各自合同。** 详细命令、恢复与传输合同见[独立核心说明](context-folding/README.md)和[传输协议](context-folding/docs/TRANSPORT.md)。

## 怎么用

### 1. 安装 Magpie 插件

从仓库根目录安装本地源码。开发检查需要 Bun >= 1.4.0、Node.js >= 22 和 npm：

```sh
npm ci
npm run check
magpie plugin add /absolute/path/magpie-context-folding
```

Magpie 直接加载 TypeScript 源码，不依赖安装时执行构建脚本。根 npm 包只包含 Magpie 插件；[Python 核心及源码适配器](context-folding/README.md)单独安装。

让 Agent 连接 Magpie 的工具服务，例如在客户端 MCP 配置中填写：

```json
{
  "mcpServers": {
    "magpie": {
      "url": "http://127.0.0.1:3425/mcp/magpie/tools"
    }
  }
}
```

客户端的具体 transport 配置格式可能不同。确认工具列表中有 `context_folding`。请求还需要稳定的会话标识，例如 `X-Magpie-Session`。插件只在确认有可调用恢复入口时改变上下文。

工具封装在 code-mode 等外层工具内时，可将 `[magpie].recovery_tool_name` 配置为已核实可调用的实际工具名。该配置声明一个真实入口，不会安装工具。请求禁止所有工具时，插件保留原文。

### 2. 给 Agent 一段短提示词

将下面这段加入宿主的固定提示词一次即可：

> 在真实任务中，用整行 `<!-- @context-fold begin LABEL -->` 和 `<!-- @context-fold end LABEL -->` 包住已完成、以后只需回查的长过程，两个 LABEL 必须一致。结论、约束和待办放在标记外。系统在延迟满足且有足够净收益时保存原文并折叠。不要制造演示文本、为门槛扩写内容或每轮查询状态。需要细节时，直接用提示中的 scope 和短哈希调用 read，沿 nextOffset 按需翻页；只有需要保持展开时才用 restore。源码使用同样标记和对应注释语法。不要计算哈希；未闭合或嵌套标记保持原样。

`LABEL` 是简短名称，例如 `route-analysis`。它帮助 Agent 识别内容，不是唯一编号，不要求手工维护哈希。

### 3. 在原有任务中使用，缺细节时再回查

例如一次实际的路由问题排查：比较方案、阅读源码和记录证据后，把可以回查的长过程闭合；下一步要执行的结论继续留在外面。继续做原任务即可，普通请求会推进等待周期，无需专门调用工具来“触发”折叠。

```text
<!-- @context-fold begin route-analysis -->
这里放实际排查中产生的过程和证据。
<!-- @context-fold end route-analysis -->

保留结论：下一步检查 router.ts 的超时分支；失败重试仍未验证。
```

这是语法示意，短示例本身通常达不到收益门槛，不应复制成一次演示任务。候选批次值得折叠时，第一次请求观察到完整标记，正文仍可见；经过默认的一个请求周期，满足净收益门槛的成熟批次才替换成 `[[cf:v2:<hash>]]`，两个标记行保留。相同请求的重试不消耗等待周期；没有后台计时器，不会修改正在生成的流式响应。跨消息配对只收起 Assistant 的普通文本切片，每个切片显示同一个引用，避免制造空消息；工具调用及工具结果留在原位置；新的用户消息会截断尚未闭合的范围。

源码用同一核心语法，例如：

```rust
// @context-fold begin parse-options
let options = parse_options(input)?;
validate_options(&options)?;
// @context-fold end parse-options
```

Python 用 `#`，JavaScript/TypeScript 用 `//`，也可使用对应语言的完整块注释。折叠只改变发送给模型的视图，原文件不改写。Magpie 请求钩子会处理能够核实来源的单一文本源码读取结果；普通工具 JSON、部分读取及无法确认格式的结果保持原样。其他宿主需要接入[源码适配器](context-folding/README.md#source-annotations-and-compact-reads)，独立 MCP 服务本身不能拦截另一个工具。

网关对 Python 和 JavaScript/TypeScript 使用保守词法过滤，排除字符串里的伪标记；遇到 f-string、无法可靠区分的模板插值或 JSX 等复杂结构时保留该份源码。独立 Python 核心使用 Python tokenizer 和可选的 JS/TS Tree-sitter 语法分析，能力范围不同。其他语言仍使用整行字面协议，不能保证排除多行字符串中的伪标记。

## 先检查整批净收益

Magpie 请求钩子先模拟替换后的完整请求，再决定是否建立正文归档及等待记录：

```text
净减少估算 = 原请求估算 tokens - 折叠后完整请求估算 tokens
接受新折叠批次 = 净减少估算 >= max(1, min_saving_tokens)
```

估算方式是 `ceil(JSON 的 UTF-8 字节数 / 4)`。计算包含每个引用、协议包装、scope 提示，以及启用预算提示时的预算开销。同一批候选共同承担提示开销，不要求每一个小块单独达到 256。

未达到门槛的候选批次保留原文，不为它新建正文归档条目；最近决策会记录 `insufficient-savings`。达到延迟后，还会仅对本次真正要折叠的成熟批次再检查一次，尚在等待的长内容不能替短内容抵扣开销。门槛检查决定是否接受已有标记，不会扫描未标记的旧对话来凑收益。

`min_saving_tokens = 0` 仍要求正的净减少估算。这个门槛不是模型 tokenizer，也不计算供应商缓存价格、以后读回的成本或任务质量；它只保证接受的新折叠批次在本次请求的估算中足够缩短。

## 短哈希与恢复

系统按实际折叠正文的 UTF-8 字节计算 SHA-256，引用为 `[[cf:v2:<hash>]]`，通常显示前 12 位，遇到冲突时延长。外层标记不计入正文；正文末尾的一个物理换行保留在引用外，以便精确恢复。哈希随正文变化，同名标记的不同内容不会指向同一个快照。旧引用仍恢复当时的原文，不会偷偷改成磁盘上的最新文件。

从折叠引用取出实际短哈希，使用请求提示中的 scope：

```json
{"action":"read","scope":"<current-scope>","id":"<actual-short-hash>"}
```

`read` 默认返回最多 **2,000 个 UTF-16 单元**、完整 SHA-256 和分页信息，**不改变已有折叠状态**。需要更多内容时，沿 `nextOffset` 继续读取，或显式设置 `limit`（最大 24,000）。查到所需证据即可继续任务，不必为了验证插件把全部原文读回。

只有需要让后续原始历史保持展开时，才用 `{"action":"restore","scope":"<current-scope>","id":"<actual-short-hash>"}`。它会保护原文并解除旧式祖先分组的折叠，返回同样的分页内容。旧调用方显式指定 `read`/`paste` 的 `peek:false` 仍得到保护行为；`peek:true` 与默认查阅行为相同。`read` 不会撤销已经存在的保护。

恢复工具自己的输出不会被重新折叠，返回的页也会占据后续上下文，因此按需读取仍然重要。原文只作为资料返回，不执行其中的旧命令。

其余工具用于按需查找和维护，不是每轮必走的流程：

| Action | 用途 |
| --- | --- |
| `read` | 按短哈希或已有归档 ID 查阅一页原文，默认保留折叠。 |
| `restore` | 显式保持原文展开，并返回一页内容；适合后续持续需要原文的情况。 |
| `list` | 找回忘记的引用，或检索旧归档。 |
| `paste` | 将原文写到宿主上的新文件，默认不改变折叠状态，拒绝覆盖现有文件。 |
| `status` | 简要显示数量、最近决策及累计净减少估算；`detail:true` 追加完整统计。 |
| `stats` | 查看累计折叠和恢复统计；token 数是估算。 |
| `forget` | 清理已经恢复、没有仍在使用的折叠引用的会话归档。 |

根插件的分页偏移按 JavaScript UTF-16 单元计数，直接使用 `nextOffset`。Python 核心使用 Unicode 码点偏移，二者不能混用。scope 是会话恢复能力值，不应转交其他会话。旧归档的原文、历史层和分组清单仍可读取；0.4.0 不再创建旧式摘要层或通过 `mark` 建组。

根插件 CLI 的 `magpie-context-folding read` 保留向 stdout 输出完整原文的管道用法，`--limit` 才限制为一页；它同样默认不保护原文。显式保护使用 `restore` 或 `read --keep`，完整状态使用 `status --detail`。这是根插件 CLI，不是独立 Python 的 `ctxf` 命令。

## 默认安静，预算按需显示

默认没有配置模型窗口，也没有当前折叠引用时，插件不追加动态提示。存在当前折叠引用、需要给出恢复位置时，只放一条会话内稳定的提示：

```text
<context-folding scope=<current-scope> />
```

只有显式配置 `context_window_tokens`，请求钩子才更新预算提示；此时即使没有折叠，也会产生所请求的预算提示开销：

```text
<context-budget used_estimate=31200 capacity=128000 output_reserved=8000 available_estimate=88800 basis=json-utf8-bytes/4 scope=<current-scope> />
```

数值仅为格式示例；真实 scope 是 64 位十六进制值。无当前折叠引用时，预算提示省略 scope。使用量按完整请求 JSON 的 UTF-8 字节数除以四、向上取整，包含提示自身的开销；这不是模型 tokenizer 的精确计数。

配置了模型窗口后，可以显示估算剩余量：

```text
remaining = max(0, context_window_tokens - reserve_output_tokens - estimated_input)
```

插件不根据模型名称猜容量。剩余量变小也不会触发被动折叠，更不会替 Agent 决定哪些资料已经不重要。提示会替换已有的本插件提示，不累积教程或回执。“不追加动态提示”不表示插件工具定义本身没有上下文开销。

## 配置

按内置默认值、全局配置、最近的项目配置、插件 options 顺序覆盖。全局文件为 `$XDG_CONFIG_HOME/context-folding/config.toml` 或 `~/.config/context-folding/config.toml`；项目文件为 `.context-folding.toml`，向上搜索到 Git 根目录即止。

```toml
version = 1

[folding]
enabled = true
delay_requests = 1
min_saving_tokens = 256
max_session_bytes = 67108864
reserve_output_tokens = 0
# 只有已知模型实际窗口时才填写：
# context_window_tokens = 128000

[magpie]
# 仅在恢复工具由宿主包装、无法从当前请求声明发现时设置：
# recovery_tool_name = "mcp__magpie__magpie_context_folding_context_folding"
# gateway_timeout_ms = 3000
```

插件 options 使用对应 camelCase：`delayRequests`、`minSavingTokens`、`maxSessionBytes`、`contextWindowTokens`、`reserveOutputTokens`、`recoveryToolName`、`gatewayTimeoutMs`。`delay_requests = 0` 允许在首次完整观察到闭合标记、且达到收益门槛的请求中折叠；默认值 1 留出一次完整观察机会。`min_saving_tokens` 是 Magpie 新折叠批次的净减少估算下限，不改变 Python 的显式 `ctxf fold` 行为。

`max_session_bytes` 是归档容量上限，不是折叠阈值。存档失败、容量不足、并发状态冲突或无法确认恢复入口时，保留原文。默认状态目录为 `$XDG_DATA_HOME/magpie-context-folding` 或 `~/.local/share/magpie-context-folding`，可通过 `MAGPIE_CONTEXT_FOLDING_STATE_DIR` 指定。

## 更新现有 0.4.0 源码使用方式

版本仍为未发布的 0.4.0，更新本地源码时请同步固定提示词和依赖工具返回值的脚本：

- 不再用两段短笔记和多次状态查询作为日常使用流程。短标记可能因为净收益不足而保持原文；不要扩写凑门槛。
- `read`/`paste` 的默认 `peek` 从 `false` 改为 `true`。需要原有保持展开行为时改用 `restore`，或明确传 `peek:false`；CLI 使用 `restore` 或 `--keep`。
- 工具 `read` 默认页长从 4,000 改为 2,000 个 UTF-16 单元。沿返回的 `nextOffset` 翻页；CLI 全文 stdout 导出用法保留。
- `status` 默认不再携带完整 `metrics`；依赖该字段的程序传 `detail:true`，CLI 传 `--detail`。
- 未配置窗口时，恢复 scope 从 `<context-folding ... />` 取得；配置已知窗口时仍可从 `<context-budget ... />` 取得。没有当前折叠时默认不发送 scope 提示。

这些变更不修改独立 Python 核心的默认恢复语义，也不需要清空旧归档。

## 从 0.3.x 升级

删除配置中的 `mode`、`threshold_tokens`、`keep_recent_messages`、`head_chars`、`minimum_saving_usd`、`[policy]` 和 `[magpie.accounting]`。这些设置不会静默映射成另一种自动策略；旧配置会给出迁移错误。

删除 Agent 提示词里关于 `mark`、三档切换、自动摘要和成本批准的操作要求，换成上面的标记说明。保留旧数据库，以便恢复仍在引用的内容；不要靠删除归档解决配置错误。

## 机制边界

- 未闭合、错配或嵌套的区域保持原文，其中的子区也不折叠；此前独立闭合的合法区域不受影响。孤立结束标记保持字面文本。普通句子中的示例字符串不是标记，标记必须独占一行。
- 未标记内容、用户指令、工具调用参数、普通工具结果、图片及签名推理字段不会被此协议顺带删除。
- 内容哈希和出现位置分别跟踪。同一份内容刚被再次读取，不能仅因旧副本曾折叠就立即藏起。
- 先持久保存原文，成功后才替换视图；归档引用是恢复入口，不是授权凭据。
- 插件修改本次发给模型的请求，不接管客户端默认 compaction，也无法修改供应商保存的隐藏历史。需要当前完整、可编辑的历史才能应用折叠。
- 字节减少、估算 token 减少、任务质量和真实账单节省是不同指标。本次源码重构不继承旧策略的性能或费用结论。

详细协议见 [注释协议](docs/annotation-protocol.md)，并发恢复见 [恢复一致性](docs/recovery-consistency.md)。测试使用 `npm run check`；源码适配器与 SDK 的验证命令见[子项目说明](context-folding/README.md)。

## Harbor 基准测试

已接入固定版本 Harbor，以相同模型、任务和工具分别测试完整历史与主动注释折叠。适配层调用本项目实际请求钩子和恢复工具，记录独立判题结果、API 用量、恢复次数及耗时。提供不调用模型的 Docker smoke、两个合成任务和外部数据集入口。

使用方式见 [Harbor 基准说明](benchmarks/harbor/README.md)，验证范围见 [接入回执](docs/harbor-validation.md)。
