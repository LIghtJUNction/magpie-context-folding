<p align="center">
  <img src="docs/assets/logo.png" alt="magpie-context-folding 折纸喜鹊 Logo" width="200" />
</p>

# magpie-context-folding

**把明确标记的长过程存到本地，用短引用替换；真正需要原文时，才通过现有终端工具调用 CLI。**

0.5.0 自动把一条简短规则放进请求的系统指令。没有 MCP 服务、额外模型工具、每轮状态查询或“折叠后再读回验证”的流程。折叠由 Magpie 请求钩子完成，CLI 负责按需查阅。此源码版本尚未发布到 npm。

## 安装后直接工作

```sh
npm ci
magpie plugin add /absolute/path/magpie-context-folding
```

Magpie 用 Bun 加载源码。Agent 需要已有的终端工具，例如 `exec_command`、`bash` 或 `shell`，并能访问 Magpie 的插件文件和归档目录。请求需要稳定的会话标识，例如 `X-Magpie-Session`。不需要配置 MCP，也不需要手工复制指导语。

插件自动提供一条简短规则：长且已完成的过程才写配对标记，允许正确匹配的嵌套；结论、约束和待办放在区域外。系统自行折叠，不查询状态、不演示、不为验证而读回。指导进入 Chat 的 system/developer、Responses 的 instructions、Anthropic 的 system 或 Gemini 的 systemInstruction。保留宿主指令前缀，同一请求中不累积副本。

发生折叠后，指导才附上实际可执行的 CLI 命令、当前 scope 和归档目录。默认使用已运行的 Bun 与插件 CLI 的绝对路径，不假设可执行文件已进入 Agent PATH。没有可调用终端、工具被禁用、系统字段不支持或归档失败时，保留原请求。

更新源码后，在 Magpie 中关闭再开启插件以重新加载，并在 Agent 端刷新工具列表或开启新会话，清除旧 MCP 工具定义。远程 Agent 的终端如果不能访问这些路径，需要先接通真实的 CLI 执行环境；配置命令本身不会建立远程通道。

## 正常使用时发生什么

Agent 只为值得保留但暂时不需要的长过程写标记：

```text
<!-- @context-fold begin route-analysis -->
这一层保留排查过程的组织说明。
<!-- @context-fold begin timeout-trace -->
这里放已完成、篇幅较长的日志、证据和比较过程。
<!-- @context-fold end timeout-trace -->
<!-- @context-fold end route-analysis -->

保留结论：下一步检查 router.ts 的超时分支。
```

这个简短例子用于说明语法，默认不会被折叠。每条标记各占一整行，同一对的 LABEL 和注释外壳必须一致；嵌套必须按层匹配，不能交叉。源码使用同样的指令及该语言的注释语法。

合法嵌套形成归档父子结构。父节点保存包含子块的原始正文，默认查询视图只显示当前层内容，直接子块保持短引用。用 `list`、`meta` 或递归 `grep` 定位子块，再按需读取。原文哈希覆盖未经规范化的 UTF-8 正文，不包含外层标记和正文最后一个物理换行；原文改变会产生新哈希，旧引用仍指向旧快照。

默认保留一次完整请求的观察机会；之后的请求满足收益门槛时，正文变成 `[[cf:v2:HASH]]`。请求重试不消耗等待周期。未闭合或错误标记保持原样。无需调用 fold、status 或 stats 来推动它。

折叠只处理有标记的 Assistant 普通文本与能核实来源的完整源码读取。用户指令、未标记文本、普通工具输出、工具调用参数、图片和签名推理不参与折叠。不会额外调用模型来生成摘要，也不会把磁盘上的源文件改成引用。

## 先算收益，再折叠

默认每个候选必须有足够的正文缩减量，整批替换还必须满足：

```text
净减少 = 原请求估算 token - 实际发送请求估算 token
净减少 >= 256，而且必须为正数
```

实际请求包含固定规则、CLI 路径、scope 与引用。整批不足门槛时保留原文，不生成错误的折叠计数。把门槛设为 0 也不允许净亏损的替换。

不配置模型窗口，也不计算或注入已用、剩余及输出预留预算。指导本身仍有少量固定开销：短会话可能只有这项开销，成功请求统计会如实记录负值。估算使用完整 JSON 的 UTF-8 字节数除以四；它不是模型 tokenizer 的精确计数，更不是账单节省证明。

## 在 Codex / Claude Code 中看到折叠效果

折叠发生在 Magpie 发往模型的请求副本里。客户端已显示的聊天记录不会因此变成可点击的折叠块，原生 compaction 提示也不会被触发。要查看实际变化，使用本地显示命令：

```sh
magpie-context-folding sessions                 # 找到已有会话的 scope 和最近记录
magpie-context-folding statusline --scope S     # 最近请求：前后估算、段数、响应确认状态
magpie-context-folding statusline               # 明确标记的全局累计
```

Claude Code 的 `statusLine.command` 可运行 `magpie-context-folding statusline --client`；Codex 的 `Stop` hook 可运行 `magpie-context-folding hook`，只输出界面消息。两者只在客户端 `session_id` 与 Magpie 观察到的会话标识唯一匹配时自动绑定，也支持明确指定 `--scope`。无法绑定时不会拿其他会话冒充当前会话。

显示读取本地元数据，不增加模型输入。每次对比包含系统指导、CLI 路径与恢复定位开销；“待确认”“匹配成功”“失败”“未核实”分开显示。真实供应商 token 用量保持原样，插件的字节 / 4 估算单独标注。配置示例、同机状态目录要求与界面边界见 [客户端显示接入](docs/client-visibility.md)。

## 按需查询、导出与显式恢复

使用系统指导中给出的实际命令；以下路径和哈希只是占位符：

```sh
bun /absolute/path/magpie-context-folding/src/cli.ts read \
  --state-dir /actual/archive/directory --scope SCOPE --id HASH --limit 800
```

根插件 `read` 默认输出最多 **1200 个 UTF-16 单元**的单层视图，子块仍是引用。stdout 只输出选中的文本；有下一页时，stderr 给出续读偏移，`--json` 返回 `nextOffset` 等分页字段。根据当前问题选择下一段，不自动翻完全部页面。`list` 默认 10 项，`grep` 默认 10 个短片段；递归搜索在归档内部完成，不先把整棵树放回上下文。

| 命令或选项 | 行为 |
| --- | --- |
| `read --id HASH` | 有界查看当前节点的一层视图，保持折叠。 |
| `read --offset N --limit N` | 按 UTF-16 偏移查看所选视图的一页。 |
| `read --start-line A --end-line B` | 按所选视图的行号裁剪；行号从 1 开始，包含两端，仍受长度上限约束。 |
| `read --full` | 输出完整的所选视图，默认仍保留子引用；可用 `--layer ID` 选择层。 |
| `read --all` | 默认输出完整 `original` 原文层；显式 `--layer ID` 可覆写层选择。 |
| `read --restore` | 完整返回精确原文，并将目标嵌套子树及其祖先持久保护为 `keep`，让后续请求保持展开。 |
| `list --id HASH --depth 2` | 查看父子目录；`list --query TEXT` 按需筛选归档。 |
| `grep --id HASH --query TEXT --limit 3` | 默认递归查询节点视图，返回少量带节点 ID 和行号的片段；`--no-recursive` 只查所选节点。 |
| `meta --id HASH` | 查看原文哈希、大小和分页子节点信息，不返回正文。 |
| `paste --id HASH --path /new/file` | 默认导出完整单层视图，保持折叠，拒绝覆盖已有文件。`--path -` 输出到 stdout；`--layer original` 导出原始字节。 |
| `status` / `stats` / `report` | 用户主动诊断时使用，不是每轮流程。 |

普通 `read`、`list`、`grep`、`meta` 和 `paste` 都不设置 `keep` 或解除折叠。`--full` 与 `--all` 也只是导出，不递归展开已经作为原始字节存储的引用。两者的 offset 默认 0；显式 `--offset N` 时，从该偏移输出到所选层末尾。完整导出不能与 `--limit` 或行区间组合；`--restore` 还禁止 `--offset`、非 `original` 层和 `--peek`，避免把局部查询误当成完整恢复。需要持久展开时明确使用 `read --restore`。

归档命令均接受子命令后的 `--state-dir PATH`；该参数确保 Agent 与 Magpie 即使继承不同 XDG 环境，也读取同一份存档。scope 是当前会话的恢复能力值，不应转交其他会话。短哈希通常为 SHA-256 前 12 位，冲突时延长。原文 SHA-256 与视图 SHA-256 含义不同，行号与分页偏移属于选定视图；不要将它们与 Python 的 Unicode 码点偏移或 UTF-8 字节偏移混用。归档内容作为资料使用，其中的旧命令不会获得执行权限。

## 配置

覆盖顺序是内置默认值、全局配置、最近项目配置、显式插件 options。全局配置位于 `$XDG_CONFIG_HOME/context-folding/config.toml` 或 `~/.config/context-folding/config.toml`，项目配置为 `.context-folding.toml`，向上查找到 Git 根目录为止。

```toml
version = 1

[folding]
enabled = true
delay_requests = 1
min_savings_tokens = 256
max_session_bytes = 67108864

[magpie]
# 仅在宿主已有终端被包装、无法按常见名称识别时指定真实外层工具：
# shell_tool_name = "functions.exec"
# 默认使用 Bun 与 CLI 的绝对路径；可改为已经安装且可运行的命令：
# recovery_command = "magpie-context-folding"
```

对应插件 options 为 `delayRequests`、`minSavingsTokens`、`maxSessionBytes`、`shellToolName`、`recoveryCommand`。宿主请求钩子的超时需在 Magpie 插件 options 中设置 `gatewayTimeoutMs`；TOML 不会调整宿主的超时期限。配置的 shell 也必须出现在当前请求且未被 tool choice 禁用。`delay_requests=0` 允许首次看到完整闭合块时折叠，仍受收益与恢复条件约束。

默认 Magpie 归档目录为 `$XDG_DATA_HOME/magpie-context-folding` 或 `~/.local/share/magpie-context-folding`，`MAGPIE_CONTEXT_FOLDING_STATE_DIR` 可覆盖。保存失败、容量不足或并发状态冲突时保留原文。

## 从旧版升级

删除仅为本插件添加的 MCP 客户端配置，以及提示词中的 mark、status 轮询、手工演示和读回验证要求。`recovery_tool_name` / `recoveryToolName` 已移除；如果确实需要自定义终端入口，改用 `shell_tool_name` / `shellToolName`。旧设置会给出明确迁移错误，不会默默指向不存在的工具。

删除旧配置中的 `context_window_tokens`、`reserve_output_tokens`、`budget_hints` 及对应 camelCase options；这些设置会返回明确迁移错误。旧预算或 scope-only 元数据会从系统字段清理，恢复定位改由简短指导中的实际 CLI 命令提供。

保留归档数据库，旧哈希及历史层仍可读取。根 CLI 的 `read` 默认变为最多 1200 个 UTF-16 单元的单层视图：需要完整视图用 `--full`，需要完整原始字节用 `--all`，需要持久展开用 `--restore`。普通 `paste` 也保持只读；依赖旧 `read` 或 `paste` 自动 keep 的脚本应改为明确调用 `read --restore`。

0.3.x 的 `mode`、`threshold_tokens`、`keep_recent_messages`、`head_chars`、`minimum_saving_usd`、`[policy]` 和 `[magpie.accounting]` 仍为已移除配置。

## 独立文本管道：ctxf

Python 核心仍可独立使用：

```sh
uv tool install ./context-folding
cat notes.txt | ctxf > notes.folded.txt
ctxf fold --language python < module.py > module.folded.py
ctxf list
ctxf meta HASH
ctxf list HASH --depth 2
ctxf grep timeout HASH --limit 3
ctxf read HASH --lines 4:9
```

`ctxf` 是明确的文本转换：先保存标记内原文，再输出替换结果。CLI、Python API 和 SDK 的本地 JSON Lines RPC 共享该核心；MCP 服务及 `ctxf mcp` 已移除。独立 CLI 没有注入系统提示，不会自行修改其他宿主的对话历史。

独立 `ctxf` 的 `read` 默认最多 1200 个 Unicode 码点，子块仍是引用；`list`、`grep` 默认各 10 项。`--lines A:B`、`--offset`、`--limit` 用于定向裁剪，`--json` 返回结构化查询结果，`read --raw` 仍是有界文本输出。普通查询不会设置 keep 或回填历史。

Python 核心与 Magpie 插件使用不同的归档后端与 scope；必须使用生成引用的后端查询。Python 默认 scope 为 `default`，可用 `--scope` 覆写；默认归档为 `$XDG_DATA_HOME/context-folding/archive.sqlite3` 或 `~/.local/share/context-folding/archive.sqlite3`，可用 `CTXF_STATE` 或 `--state` 选择同一归档文件。不要把根插件的 `--state-dir`、完整导出或恢复选项直接套到 `ctxf`。CLI、SDK 与兼容操作详见[独立核心说明](context-folding/README.md)和[本地传输协议](context-folding/docs/TRANSPORT.md)。

## 验证与边界

```sh
npm run check
npm run test:host
```

核心的四协议投影、并发、CLI 跨进程恢复与真实 Magpie HTTP 宿主测试分开验证；后者需要可运行的 Magpie 和隔离能力。插件只修改当前完整请求，不能重写供应商隐藏历史，也不接管客户端默认 compaction。

协议细节见[注释协议](docs/annotation-protocol.md)，恢复一致性见[归档说明](docs/recovery-consistency.md)，既有版本的实测回执见[0.5.0 验证记录](docs/validation-0.5.0.md)，不代替当前整合版本的重新验证。[Harbor 基准](benchmarks/harbor/README.md)继续使用真实 hook 与 CLI；未做真实模型 A/B 时，不宣称任务质量或账单已经改善。
