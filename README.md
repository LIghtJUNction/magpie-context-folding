<p align="center">
  <img src="docs/assets/logo.png" alt="magpie-context-folding 折纸喜鹊 Logo" width="200" />
</p>

# magpie-context-folding

**Agent 用注释决定折叠；以后通过命令行查归档，只取需要的片段，历史保持折叠。**

支持普通 Assistant 文本和源码注释、递归嵌套、短哈希引用与持久原文。没有三档策略、自动摘要或 `mark` 流程。系统只报告预算，Agent 自己决定哪些内容可以收起。

当前根插件源码版本为 **0.4.0，未发布到 npm**。旧基准与费用报告只代表历史实现。

## 先用 ctxf

独立 Python 核心提供同一个 CLI、MCP 服务和 SDK 后端：

```sh
uv tool install ./context-folding
cat notes.txt | ctxf > notes.folded.txt
ctxf list
ctxf meta HASH
ctxf list HASH --depth 2
ctxf grep timeout HASH --limit 3
ctxf read HASH --lines 4:9
```

把 `HASH` 换成实际引用或查询返回的 ID。`fold` 保持文本管道：读 UTF-8 stdin，保存原文后输出完整折叠视图，不加日志、JSON 外壳或额外换行。`ctxf fold --language python < module.py` 使用 Python 注释解析。

查询默认输出精简：`read` 最多 1200 字符，子块仍是引用；`list` 和 `grep` 默认各 10 项；`meta` 只给哈希、大小和子节点等元数据。`grep` 在归档内递归查找，返回少量带行号的片段。查询不解除折叠、不设置 keep、不改写历史。`--limit`、`--lines` 和 `--offset` 用于定向裁剪；`--json` 返回结构化结果。`read --raw` 仍然有界，不会自动翻完全部页面。

这些输出可以继续组合：

```sh
ctxf grep timeout HASH --limit 5 | rg parser
ctxf read HASH --lines 4:9 | sed -n '1,3p'
```

默认 scope 为 `default`，可用 `--scope` 分开任务。归档默认位于 `$XDG_DATA_HOME/context-folding/archive.sqlite3`，未设置 XDG 时使用 `~/.local/share/context-folding/archive.sqlite3`；`CTXF_STATE` 或 `--state` 可覆盖。后续查询使用同一归档和 scope。

### MCP

```json
{
  "mcpServers": {
    "ctxf": {"command": "ctxf", "args": ["mcp"]}
  }
}
```

工具名仍是 `context_folding`，公开 `fold / list / grep / read / meta / status`。API 调用必须带 `scope`。`fold` 接收 `text`，返回 `{scope, text, references}`；查询只返回有界结果。宿主消费返回的视图，MCP 自身不能回写历史或接管 compaction。

CLI 细节见[独立核心说明](context-folding/README.md)与[传输协议](context-folding/docs/TRANSPORT.md)。旧 `context-folding` 命令保留兼容参数；新工作流使用 `ctxf`。

## 写标记，支持嵌套

每个标记独占一行，同一对的 `LABEL` 和注释外壳必须一致。普通文本使用 HTML 注释，源码使用 `#`、`//` 或该语言的完整块注释。

```text
<!-- @context-fold begin investigation -->
这一层保留排查的组织结构。
<!-- @context-fold begin trace -->
具体日志、比较过程和中间证据……
<!-- @context-fold end trace -->
<!-- @context-fold end investigation -->

当前结论、约束和待办放在区域外。
```

合法嵌套形成父子结构。外层折叠后，查询父块只显示它这一层的内容和子引用；通过 `list`、`meta` 或递归 `grep` 继续定位子块。`read` 不是“展开历史”操作。

哈希由系统计算，格式为 `[[cf:v2:HASH]]`，通常为 SHA-256 前 12 位，前缀冲突时延长。哈希基于未规范化的原文 UTF-8 字节；外层标记和正文最后一个物理换行不计入正文哈希。原文变化产生新哈希，旧引用始终指向旧快照。

未闭合、错配或畸形区域保持原样；此前独立闭合的合法区域不受影响。系统不会猜结束标记，也不会折叠未标记内容。

### 给 Agent 的短提示词

固定加入一次即可：

> 用整行 `<!-- @context-fold begin LABEL -->` 与匹配的 end 标记圈住可回查的过程文本，可正确嵌套。结论、约束和待办放在区域外。不要计算哈希。需要细节时，在同一归档和 scope 内用 list/meta 定位、grep 搜索、read 裁剪几行；子引用按需查询，历史保持折叠。预算仅作参考。

## 接入 Magpie 请求钩子

若要在后续模型请求中自动投影 Agent 已写出的标记，安装根插件：

```sh
npm ci
npm run check
magpie plugin add /absolute/path/magpie-context-folding
```

开发检查需要 Bun >= 1.4.0、Node.js >= 22 和 npm。Magpie 直接加载 TypeScript 源码。让客户端连接 `http://127.0.0.1:3425/mcp/magpie/tools`，确认有 `context_folding` 工具，并提供稳定会话标识，例如 `X-Magpie-Session`。只能在查询归档的工具确实可调用时折叠。

默认 `delay_requests = 1`：首次完整观察到结束标记仍保留正文；下一次有进展的请求才显示引用。同一请求重试不推进计数，没有后台计时器。跨 Assistant 消息只处理普通文本切片，工具结构保持原位；新用户指令截断未闭合范围。

Magpie 工具提供 `list / grep / read / meta / status` 等归档查询。使用预算提示中的 scope。它的存储与独立 `ctxf` 的 Python SQLite 归档分开，引用必须在生成它的后端查询。根 CLI 的维护操作仍可用，但无需每轮调用。

经核实的单一文本源码 Read 可以参加同一协议；普通工具结果和无法确认格式的读取不参加。网关对 Python/JS 使用保守词法过滤，复杂 f-string、JSX 或含歧义的模板插值会保留源码。独立 Python 核心使用 tokenizer 和可选 Tree-sitter。其他语言的整行字面协议可能误认多行字符串里的标记。

## 预算与配置

动态预算只更新一条 system 元数据，不重复注入教程：

```text
<context-budget used_estimate=31200 capacity=128000 output_reserved=8000 available_estimate=88800 basis=json-utf8-bytes/4 scope=... />
```

数值仅为示例。使用量是请求 JSON 的 UTF-8 字节数除以四、向上取整，包含提示自身，并非 tokenizer 或账单实测。容量未知就显示 `unknown`；预算不足不会触发被动选材。

```toml
version = 1

[folding]
enabled = true
delay_requests = 1
max_session_bytes = 67108864
reserve_output_tokens = 0
# context_window_tokens = 128000

[magpie]
# recovery_tool_name = "已核实可调用的工具名"
# gateway_timeout_ms = 3000
```

配置顺序为默认值、全局 `context-folding/config.toml`、最近的 `.context-folding.toml`、插件 options。项目搜索止于 Git 根目录。options 使用对应 camelCase。`delay_requests = 0` 允许首次完整观察即投影；显式 `ctxf fold` 本来就立即执行，且不修改自动投影配置。

归档容量是存储上限。原文提交失败、配额不足或无法确认查询入口时保留输入。Magpie 状态目录为 `$XDG_DATA_HOME/magpie-context-folding` 或 `~/.local/share/magpie-context-folding`，可用 `MAGPIE_CONTEXT_FOLDING_STATE_DIR` 覆盖。

## 升级与边界

删除旧 `mode`、阈值、`keep_recent_messages`、`head_chars`、成本门槛、`[policy]` 和 `[magpie.accounting]`；旧配置会给出迁移错误。删除提示词里的三档切换、`mark`、自动摘要、read 后永久展开和自动恢复全文要求。保留仍被引用的归档。

查询不会把原文重新塞回历史。原始快照仍用于校验与兼容维护，但 Agent 的日常入口是有界查询。Python 偏移按 Unicode 码点，Magpie 按 UTF-16 单元；行号基于当前节点视图，不能混用偏移。原文作为资料使用，旧命令不会因此获得执行权限。

插件只改变当前可编辑请求，不修改源码文件、签名推理、用户指令、工具参数或供应商隐藏历史，也不接管客户端默认 compaction。旧基准不证明新实现的任务质量或账单收益。

详细规则见[注释协议](docs/annotation-protocol.md)和[查询一致性](docs/recovery-consistency.md)。验证命令见[独立核心说明](context-folding/README.md#sdks-and-verification)。

## Harbor 基准测试

已接入固定版本 Harbor，以相同模型、任务和工具分别测试完整历史与主动注释折叠。适配层调用本项目实际请求钩子和恢复工具，记录独立判题结果、API 用量、恢复次数及耗时。提供不调用模型的 Docker smoke、两个合成任务和外部数据集入口。

使用方式见 [Harbor 基准说明](benchmarks/harbor/README.md)，验证范围见 [接入回执](docs/harbor-validation.md)。
