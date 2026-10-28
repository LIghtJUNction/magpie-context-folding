<p align="center">
  <img src="docs/assets/logo.png" alt="magpie-context-folding 折纸喜鹊 Logo" width="200" />
</p>

# magpie-context-folding

**Agent 用一对注释圈出以后可以收起的内容；插件保存原文，等一个请求周期，再把它换成带短哈希的引用。**

0.4.0 的折叠决定全部来自 Agent 写出的标记。没有智力、平衡、经济档位，没有按长度或预算挑选历史的策略，也不需要先列目录、再调用 `mark`。未标记的内容保持完整。预算提示只告诉 Agent 当前使用量，怎样整理上下文由 Agent 决定。

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

`ctxf` 由独立 Python 包提供；根 npm 包的 `magpie-context-folding` 继续管理 Magpie 自己的归档。两个后端的归档和 scope 不互通，恢复引用时使用生成它的后端。详细命令、恢复与传输合同见[独立核心说明](context-folding/README.md)和[传输协议](context-folding/docs/TRANSPORT.md)。

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

> 用整行 `<!-- @context-fold begin LABEL -->` 和 `<!-- @context-fold end LABEL -->` 包住以后可回查的过程文本，两个 LABEL 必须一致。需要继续保留的结论、约束和待办放在标记外。闭合后经过一个请求周期，系统会保存原文并折叠。源码使用相同标记和对应语言的注释语法。不要计算哈希；需要原文时，用系统给出的 scope 和短哈希调用 context_folding 的 read。未闭合或嵌套标记保持原样。

`LABEL` 是简短名称，例如 `route-analysis`。它帮助 Agent 识别内容，不是唯一编号，不要求手工维护哈希。

### 3. 输出开始标记，完成后输出结束标记

```text
<!-- @context-fold begin route-analysis -->
这一段是阶段性的排查、比较或推导过程。
可以是一条消息，也可以分布在同一任务轮次的多条 Assistant 普通文本消息里。
<!-- @context-fold end route-analysis -->

保留结论：下一步检查 router.ts 的超时分支；失败重试仍未验证。
```

第一次请求观察到完整标记时，正文仍可见。下一次组装请求时，正文才替换成 `[[cf:v2:<hash>]]`，两个标记行保留。相同请求的重试不消耗等待周期；没有后台计时器，不会修改正在生成的流式响应。跨消息配对只收起 Assistant 的普通文本切片，每个切片显示同一个引用，避免制造空消息；工具调用及工具结果留在原位置；新的用户消息会截断尚未闭合的范围。

源码用同一核心语法，例如：

```rust
// @context-fold begin parse-options
let options = parse_options(input)?;
validate_options(&options)?;
// @context-fold end parse-options
```

Python 用 `#`，JavaScript/TypeScript 用 `//`，也可使用对应语言的完整块注释。折叠只改变发送给模型的视图，原文件不改写。Magpie 请求钩子会处理能够核实来源的单一文本源码读取结果；普通工具 JSON、部分读取及无法确认格式的结果保持原样。其他宿主需要接入[源码适配器](context-folding/README.md#source-annotations-and-compact-reads)，独立 MCP 服务本身不能拦截另一个工具。

网关对 Python 和 JavaScript/TypeScript 使用保守词法过滤，排除字符串里的伪标记；遇到 f-string、无法可靠区分的模板插值或 JSX 等复杂结构时保留该份源码。独立 Python 核心使用 Python tokenizer 和可选的 JS/TS Tree-sitter 语法分析，能力范围不同。其他语言仍使用整行字面协议，不能保证排除多行字符串中的伪标记。

## 短哈希与恢复

系统按实际折叠正文的 UTF-8 字节计算 SHA-256，引用为 `[[cf:v2:<hash>]]`，通常显示前 12 位，遇到冲突时延长。外层标记不计入正文；正文末尾的一个物理换行保留在引用外，以便精确恢复。哈希随正文变化，同名标记的不同内容不会指向同一个快照。旧引用仍恢复当时的原文，不会偷偷改成磁盘上的最新文件。

从折叠引用取出实际短哈希，使用请求提示中的 scope：

```json
{"action":"read","scope":"<current-scope>","id":"<actual-short-hash>"}
```

`read` 返回原文、完整 SHA-256 和分页信息。默认保护读回内容，后续不再自动收起；`peek: true` 只查看，不改变已有保护状态。恢复工具自己的输出不会被重新折叠。原文只作为资料返回，不执行其中的旧命令。

其余工具用于按需查找和维护，不是每轮必走的流程：

| Action | 用途 |
| --- | --- |
| `read` | 按短哈希或已有归档 ID 读取原文，支持分页。 |
| `list` | 找回忘记的引用，或检索旧归档。 |
| `paste` | 将完整原文写到宿主上的新文件，拒绝覆盖现有文件。 |
| `status` | 检查当前会话归档与最近处理情况。 |
| `stats` | 查看累计折叠和恢复统计；token 数是估算。 |
| `forget` | 清理已经恢复、没有仍在使用的折叠引用的会话归档。 |

根插件的分页偏移按 JavaScript UTF-16 单元计数，直接使用 `nextOffset`。Python 核心使用 Unicode 码点偏移，二者不能混用。scope 是会话恢复能力值，不应转交其他会话。旧归档的原文、历史层和分组清单仍可读取；0.4.0 不再创建旧式摘要层或通过 `mark` 建组。

## 预算只提供信息

系统更新一条放在协议 system 元数据中的预算提示，不重复追加教学、安装建议或折叠回执。其格式为：

```text
<context-budget used_estimate=31200 capacity=128000 output_reserved=8000 available_estimate=88800 basis=json-utf8-bytes/4 scope=<current-scope> />
```

数值仅为格式示例；容量未知时，`capacity` 和 `available_estimate` 为 `unknown`。使用量按完整请求 JSON 的 UTF-8 字节数除以四、向上取整，包含提示自身的开销；这不是模型 tokenizer 的精确计数。

配置了模型窗口后，可以显示估算剩余量：

```text
remaining = max(0, context_window_tokens - reserve_output_tokens - estimated_input)
```

窗口未知时明确标为未知，不根据模型名称猜容量。剩余量变小也不会触发被动折叠，更不会替 Agent 决定哪些资料已经不重要。

## 配置

按内置默认值、全局配置、最近的项目配置、插件 options 顺序覆盖。全局文件为 `$XDG_CONFIG_HOME/context-folding/config.toml` 或 `~/.config/context-folding/config.toml`；项目文件为 `.context-folding.toml`，向上搜索到 Git 根目录即止。

```toml
version = 1

[folding]
enabled = true
delay_requests = 1
max_session_bytes = 67108864
reserve_output_tokens = 0
# 只有已知模型实际窗口时才填写：
# context_window_tokens = 128000

[magpie]
# 仅在恢复工具由宿主包装、无法从当前请求声明发现时设置：
# recovery_tool_name = "mcp__magpie__magpie_context_folding_context_folding"
# gateway_timeout_ms = 3000
```

插件 options 使用对应 camelCase：`delayRequests`、`maxSessionBytes`、`contextWindowTokens`、`reserveOutputTokens`、`recoveryToolName`、`gatewayTimeoutMs`。`delay_requests = 0` 表示在首次完整观察到闭合标记的请求中折叠；默认值 1 留出一次完整观察机会。

`max_session_bytes` 是归档容量上限，不是折叠阈值。存档失败、容量不足、并发状态冲突或无法确认恢复入口时，保留原文。默认状态目录为 `$XDG_DATA_HOME/magpie-context-folding` 或 `~/.local/share/magpie-context-folding`，可通过 `MAGPIE_CONTEXT_FOLDING_STATE_DIR` 指定。

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
