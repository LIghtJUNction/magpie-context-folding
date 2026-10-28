<p align="center">
  <img src="docs/assets/logo.png" alt="magpie-context-folding 折纸喜鹊 Logo" width="200" />
</p>

# magpie-context-folding

**把明确标记的长过程存到本地，用短引用替换；真正需要原文时，才通过现有终端工具调用 CLI。**

0.5.0 自动把一条简短规则放进请求的系统指令。没有 MCP 服务、额外模型工具、每轮状态查询或“折叠后再读回验证”的流程。折叠由 Magpie 请求钩子完成，CLI 负责按需查阅。此源码版本尚未发布到 npm。

## 在 Codex / Claude Code 中看到折叠效果

折叠发生在 Magpie 发往模型的请求副本里。客户端已显示的聊天记录不会因此变成可点击的折叠块，原生 compaction 提示也不会被触发。要查看实际变化，使用本次源码修复新增的本地显示命令：

```sh
magpie-context-folding sessions                 # 找到已有会话的 scope 和最近记录
magpie-context-folding statusline --scope S     # 最近请求：前后估算、段数、响应确认状态
magpie-context-folding statusline               # 明确标记的全局累计
```

Claude Code 的 `statusLine.command` 可运行 `magpie-context-folding statusline --client`；Codex 的 `Stop` hook 可运行 `magpie-context-folding hook`，只输出界面消息。两者只在客户端 `session_id` 与 Magpie 观察到的会话标识唯一匹配时自动绑定，也支持明确指定 `--scope`。无法绑定时不会拿其他会话冒充当前会话。

显示读取本地元数据，不增加模型输入。每次对比包含系统指导和恢复路径等开销；“待确认”“匹配成功”“失败”“未核实”分开显示。真实供应商 token 用量保持原样，插件的字节 / 4 估算单独标注。配置示例、同机状态目录要求与界面边界见 [客户端显示接入](docs/client-visibility.md)。

## 安装后直接工作

```sh
npm ci
magpie plugin add /absolute/path/magpie-context-folding
```

Magpie 用 Bun 加载源码。Agent 需要已有的终端工具，例如 `exec_command`、`bash` 或 `shell`，并能访问 Magpie 的插件文件和归档目录。请求需要稳定的会话标识，例如 `X-Magpie-Session`。不需要配置 MCP，也不需要手工复制指导语。

插件自动提供的固定规则只有一条：长且已完成的过程才写配对标记，结论和约束放外面；系统自行折叠，不查询状态、不演示、不为验证而读回。指导进入 Chat 的 system/developer、Responses 的 instructions、Anthropic 的 system 或 Gemini 的 systemInstruction。保留宿主指令前缀，同一请求中不累积副本。

发生折叠后，指导才附上实际可执行的 CLI 命令、当前 scope 和归档目录。默认使用已运行的 Bun 与插件 CLI 的绝对路径，不假设可执行文件已进入 Agent PATH。没有可调用终端、工具被禁用、系统字段不支持或归档失败时，保留原请求。

更新源码后，在 Magpie 中关闭再开启插件以重新加载，并在 Agent 端刷新工具列表或开启新会话，清除旧 MCP 工具定义。远程 Agent 的终端如果不能访问这些路径，需要先接通真实的 CLI 执行环境；配置命令本身不会建立远程通道。

## 正常使用时发生什么

Agent 只为值得保留但暂时不需要的长过程写标记：

```text
<!-- @context-fold begin route-analysis -->
这里放已完成、篇幅较长的排查或比较过程。
<!-- @context-fold end route-analysis -->

保留结论：下一步检查 router.ts 的超时分支。
```

这个简短例子用于说明语法，默认不会被折叠。两条标记必须各占一整行、使用相同 LABEL。完整配对的区域可以嵌套：被包含的区域是子节点，父节点是直接包含它的最近一层。交叉、错配和未闭合的区域保持原文。源码使用同样的指令及该语言的注释语法。

默认保留一次完整请求的观察机会；之后的请求满足收益门槛时，正文变成 `[[cf:v3:NODE_ID]]`。NODE_ID 是这次出现的完整节点 ID，正文 SHA-256 另外保存。请求重试不消耗等待周期。未闭合或错误标记保持原样。无需调用 fold、status 或 stats 来推动它。

折叠只处理有标记的 Assistant 普通文本与能核实来源的完整源码读取。用户指令、未标记文本、普通工具输出、工具调用参数、图片和签名推理不参与折叠。不会额外调用模型来生成摘要，也不会把磁盘上的源文件改成引用。

## 先算收益，再折叠

默认每个候选必须有足够的正文缩减量，整批替换还必须满足：

```text
净减少 = 原请求估算 token - 实际发送请求估算 token
净减少 >= 256，而且必须为正数
```

实际请求包含固定规则、CLI 路径、scope、引用，以及显式开启的预算提示。整批不足门槛时保留原文，不生成错误的折叠计数。把门槛设为 0 也不允许净亏损的替换。

预算提示默认关闭，避免每轮发送动态 used/capacity 字段。指导本身仍有少量固定开销：短会话可能只有这项开销，成功请求统计会如实记录负值。估算使用完整 JSON 的 UTF-8 字节数除以四；它不是模型 tokenizer 的精确计数，更不是账单节省证明。

## 需要原文时只读所需片段

使用系统指导中给出的实际命令；以下路径和节点 ID 只是占位符：

```sh
bun /absolute/path/magpie-context-folding/src/cli.ts read \
  --state-dir /actual/archive/directory --scope SCOPE --id NODE_ID --limit 800
```

`read` 默认输出最多约 4,000 个 UTF-16 单元，只向 stdout 写原文。查看不会解除折叠。仍有下一页时，stderr 给出续读偏移；`--json` 则返回 `nextOffset`，沿这个偏移继续读取即可。

| 命令或选项 | 行为 |
| --- | --- |
| `read --id NODE_ID` | 有界查看；原归档继续保持折叠。 |
| `read --offset N --limit N` | 只查看当前任务需要的一页。 |
| `read --all` | 显式读取完整原文，仍保持折叠。 |
| `read --restore` | 将原文标记为 `keep`，并解除旧祖先组的折叠，让后续原始历史保持展开。 |
| `list --parent NODE_ID` | 浏览直接子节点；返回位置和内容哈希，不加载全文到输出。 |
| `list --recursive` | 分页枚举当前会话的节点，保留重复内容的每个出现位置。 |
| `search --query TEXT` | 搜索归档原文，返回节点 ID、命中片段和可直接传给 read 的偏移。 |
| `search --id NODE_ID --query TEXT` | 将搜索限制在指定节点的子树中；`grep` 是 search 的别名。 |
| `meta --id NODE_ID` | 查看父节点、原始范围及分页子节点元数据。 |
| `paste --path /new/file` | 完整导出，保持折叠，拒绝覆盖已有文件。 |
| `status` / `stats` / `report` | 用户主动诊断时使用，不是每轮流程。 |

归档命令均接受子命令后的 `--state-dir PATH`；该参数确保 Agent 与 Magpie 即使继承不同 XDG 环境，也读取同一份存档。scope 是当前会话的恢复能力值，不应转交其他会话。新引用使用完整节点 ID；旧 v1/v2 归档仍可读。正文相同但位置不同的节点共享内容存储，不共享父节点。恢复的是当时的精确原文，不能执行其中的旧命令。

## 一个数据库，原文与位置分开

原文存为 `hash → text`；节点保存内容哈希、来源范围和直接父节点。相同正文只需存一份，但在两个位置出现就有两个节点。父子来自实际包含关系，不能根据标签或文本相似度建立。

`list`、`search`、`meta` 和默认 `read` 都是查询，不改变折叠状态。父节点保存完整原文，读取它时不会再追加子节点全文。搜索直接扫描所选会话或子树的原文，返回可定位的命中，不依赖摘要或向量服务。接口与兼容细节见[哈希归档和包含树](docs/hash-archive.md)。

## 配置

覆盖顺序是内置默认值、全局配置、最近项目配置、显式插件 options。全局配置位于 `$XDG_CONFIG_HOME/context-folding/config.toml` 或 `~/.config/context-folding/config.toml`，项目配置为 `.context-folding.toml`，向上查找到 Git 根目录为止。

```toml
version = 1

[folding]
enabled = true
delay_requests = 1
min_savings_tokens = 256
budget_hints = false
max_session_bytes = 67108864
# 可选预算信息；仅 budget_hints=true 时发送：
# context_window_tokens = 128000
# reserve_output_tokens = 8000

[magpie]
# 仅在宿主已有终端被包装、无法按常见名称识别时指定真实外层工具：
# shell_tool_name = "functions.exec"
# 默认使用 Bun 与 CLI 的绝对路径；可改为已经安装且可运行的命令：
# recovery_command = "magpie-context-folding"
```

对应插件 options 为 `delayRequests`、`minSavingsTokens`、`budgetHints`、`maxSessionBytes`、`contextWindowTokens`、`reserveOutputTokens`、`shellToolName`、`recoveryCommand`。宿主请求钩子的超时需在 Magpie 插件 options 中设置 `gatewayTimeoutMs`；TOML 不会调整宿主的超时期限。配置的 shell 也必须出现在当前请求且未被 tool choice 禁用。`delay_requests=0` 允许首次看到完整闭合块时折叠，仍受收益与恢复条件约束。

默认 Magpie 归档目录为 `$XDG_DATA_HOME/magpie-context-folding` 或 `~/.local/share/magpie-context-folding`，`MAGPIE_CONTEXT_FOLDING_STATE_DIR` 可覆盖。保存失败、容量不足或并发状态冲突时保留原文。

## 从旧版升级

删除仅为本插件添加的 MCP 客户端配置，以及提示词中的 mark、status 轮询、手工演示和读回验证要求。`recovery_tool_name` / `recoveryToolName` 已移除；如果确实需要自定义终端入口，改用 `shell_tool_name` / `shellToolName`。旧设置会给出明确迁移错误，不会默默指向不存在的工具。

保留归档数据库，旧哈希及历史层仍可读取。CLI 和内部归档 API 的 `read` 都默认只读：旧脚本需要完整输出时加 `--all`，需要持久展开时显式使用 `--restore`。旧脚本若依赖“读取即恢复”，需要明确请求恢复。

0.3.x 的 `mode`、`threshold_tokens`、`keep_recent_messages`、`head_chars`、`minimum_saving_usd`、`[policy]` 和 `[magpie.accounting]` 仍为已移除配置。

## 独立文本管道：ctxf

Python 核心仍可独立使用：

```sh
uv tool install ./context-folding
cat notes.txt | ctxf > notes.folded.txt
ctxf fold --language python < module.py > module.folded.py
ctxf list --recursive
ctxf search --query '之前的报错'
ctxf read --id NODE_ID --offset 0 --limit 800
```

`ctxf` 是明确的文本转换：先保存标记内原文，再输出替换结果。CLI、Python API 和 SDK 的本地 JSON Lines RPC 共享该核心；MCP 服务及 `ctxf mcp` 已移除。独立 CLI 没有注入系统提示，不会自行修改其他宿主的对话历史。

Python 核心与 Magpie 插件使用不同的归档后端与 scope；必须使用生成引用的那个后端恢复。Python 的 `read --raw` 保留完整管道输出契约，不能与根插件有界 `read` 的参数及偏移混用。详见[独立核心说明](context-folding/README.md)。

## 验证与边界

```sh
npm run check
npm run test:host
```

核心的四协议投影、并发、CLI 跨进程恢复与真实 Magpie HTTP 宿主测试分开验证；后者需要可运行的 Magpie 和隔离能力。插件只修改当前完整请求，不能重写供应商隐藏历史，也不接管客户端默认 compaction。

协议细节见[注释协议](docs/annotation-protocol.md)，恢复一致性见[归档说明](docs/recovery-consistency.md)，本次结果见[0.5.0 验证记录](docs/validation-0.5.0.md)。[Harbor 基准](benchmarks/harbor/README.md)继续使用真实 hook 与 CLI；未做真实模型 A/B 时，不宣称任务质量或账单已经改善。
