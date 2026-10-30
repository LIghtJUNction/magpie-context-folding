<p align="center">
  <img src="docs/assets/logo.png" alt="magpie-context-folding 折纸喜鹊 Logo" width="176">
</p>

<div align="center">
  <h1>magpie-context-folding</h1>
  <p><strong>让 Agent 主动收起已经完成的长过程，同时保留可精确恢复的原文。</strong></p>
  <p>显式标记 · 持久归档 · 延迟折叠 · 内容哈希 · CLI 恢复</p>

  [![Release](https://img.shields.io/github/v/release/LIghtJUNction/magpie-context-folding?style=flat-square)](https://github.com/LIghtJUNction/magpie-context-folding/releases/latest)
  [![npm](https://img.shields.io/npm/v/magpie-context-folding?style=flat-square&logo=npm)](https://www.npmjs.com/package/magpie-context-folding)
  [![License](https://img.shields.io/github/license/LIghtJUNction/magpie-context-folding?style=flat-square)](LICENSE)

  [安装](#安装) · [一分钟理解](#一分钟理解) · [恢复](#恢复原文) · [独立核心](#独立文本核心-ctxf) · [协议](docs/annotation-protocol.md)
</div>

## 一分钟理解

它本质上不是摘要模型，而是一段**可逆文本替换**：

```text
Agent 写出阶段结论
      ↓
用注释标记包住长过程
      ↓
插件先把原文持久化
      ↓
等待一个请求周期
      ↓
把正文替换成 [[cf:v2:<短哈希>]]
      ↓
需要时按 scope + 哈希精确读回
```

示例：

```text
保留结论：下一步检查 router.ts 的超时分支；失败重试仍未验证。
<!-- @context-fold begin route-analysis-details -->
这里是较长的排查、比较、日志和推导过程。
<!-- @context-fold end route-analysis-details -->
```

第一次完整观察到闭合标记时，正文仍保留。下一次组装请求时，如果达到最小净节省门槛，正文才变成引用：

```text
<!-- @context-fold begin route-analysis-details -->
[[cf:v2:4db3a91c6e2f]]
<!-- @context-fold end route-analysis-details -->
```

插件不猜哪些内容“不重要”。未标记、未闭合、错配或节省量不足的内容保持原样。

## 它解决什么问题

长任务里，历史通常同时包含两种信息：

- **仍需要每轮携带的状态**：结论、约束、失败、待办、当前文件和下一步；
- **偶尔才需要回查的证据**：长日志、探索过程、大段源码、重复比较和已经结束的推导。

折叠协议要求 Agent 先在标记外留下可独立理解的状态，再把第二类内容包起来。这样后续请求仍看得到任务状态，需要证据时又能从本地归档精确恢复，而不是依赖不可逆摘要。

## 0.5.2 的可验证变化

当前发布版 `0.5.2` 还对长源码读取做保守投影：当问题能唯一定位到一个函数时，后续请求只保留该函数和可确认的文件级字面量常量；问题有歧义时继续保留完整源码。被省略的定义仍在归档中，可用 `grep` / `read` 查回。

发布验证记录包括：

- TypeScript 类型检查、构建和 312 项 Bun 测试通过；
- 隔离 Magpie host smoke 中 29/29 请求到达本地合成上游，46,278 字节合成源码可精确恢复；
- 本地合成投影基准中，定向请求为 1,086–1,177 B，完整源码请求为 127,340–127,439 B。

这些数字只证明本地代码路径、序列化字节和恢复行为。它们没有调用真实 Provider，不证明回答质量等价、真实 token、账单节省或任务提速。完整方法和限制见 [基准与质量记录](docs/cost-speed-quality.md)。

## 安装

### Magpie 插件

```bash
magpie plugin add npm:magpie-context-folding@0.5.2
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

插件会自动注入简短指导。需要手动补充时，可使用下面这段：

> 每完成一段实质性工作，先在标记外写出可独立理解的当前结论、约束、失败和下一步，再用 `@context-fold begin/end` 注释包住较长的支撑过程。不要标记仍在进行的内容，不要计算哈希。需要原文时，使用系统提供的 scope 和短哈希调用本地恢复 CLI。

`LABEL` 只用于阅读，例如 `route-analysis-details`；内容身份来自实际正文的 SHA-256，不依赖标签名。

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

## 恢复原文

从引用中取出实际短哈希，并使用请求提示中的 scope：

```bash
magpie-context-folding read \
  --scope 'CURRENT_SCOPE' \
  --id 'ACTUAL_SHORT_HASH' \
  --restore
```

主要命令：

| 命令 | 作用 |
| --- | --- |
| `read` | 读取折叠视图、完整原文或分页结果 |
| `list` | 找回忘记的引用和历史归档 |
| `grep` | 在归档中搜索定义、字符串或证据 |
| `meta` | 查看节点、父子关系和哈希元数据 |
| `paste` | 将选定内容写入新文件，拒绝覆盖已有文件 |
| `status` | 查看当前会话和最近处理状态 |
| `stats` | 查看字节和估算 token 统计 |
| `forget` | 清理已无活动引用的会话归档 |

`scope` 是会话恢复能力值，不应交给其他会话。恢复得到的是历史资料，不会自动执行其中的旧命令。

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
delay_requests = 1
max_session_bytes = 67108864
min_savings_tokens = 256

[magpie]
# shell_tool_name = "shell"
# recovery_command = "/path/to/magpie-context-folding"
# gateway_timeout_ms = 3000
```

`delay_requests = 1` 表示留出一次完整观察机会；`min_savings_tokens` 是估算净节省门槛；`max_session_bytes` 是归档容量上限，不是自动折叠阈值。

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
