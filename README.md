# magpie-context-folding

给 Magpie 提供可逆的上下文折叠。历史用户消息、模型回复和工具结果都能折叠，原文保持可读，不只是截断工具输出。

Agent 通过 `context_folding` 工具主动标注哪些内容可以折叠、哪些必须保留。达到阈值且费用门槛通过后，插件在发往模型的请求中将已标记内容替换成「简短摘要 + 来源角色及原文范围 + 开头片段 + 恢复入口」。客户端自己的完整历史不被改写。

**默认没有可信计费数据时不执行自动折叠。** 本项目不把字符估算或假定未来轮数当成省钱证明。可先使用标记、查看和状态功能；自动折叠需要配置下述 accounting 服务。

## 安装和连接工具

直接安装已发布的版本：

本文描述当前开发分支；摘要优先、来源角色、原文范围和摘要归因指引尚未包含在已发布的 `0.2.0` 中。需要这些改进时使用下方本地源码安装方式。

```sh
magpie plugin add 'npm:magpie-context-folding@0.2.0'
# 也可以安装 GitHub 的固定版本
magpie plugin add 'github:LIghtJUNction/magpie-context-folding#v0.2.0'
```

GitHub Release 同时托管 npm 格式安装包及 SHA-256 校验文件。Magpie 使用 Bun 直接加载包内 TypeScript 源码，不依赖安装时构建脚本，也不需要在源码仓库保存重复的编译产物。

从本地源码开发和安装时：

```sh
npm ci
npm run check
magpie plugin add /绝对路径/magpie-context-folding
```

开发检查需要 Bun、Node.js 和 npm。

包内同时提供 `magpie.hooks` 请求钩子和自定义工具。需要让使用 Magpie 的 agent 连接其 HTTP MCP 服务：

```json
{
  "mcpServers": {
    "magpie": {
      "url": "http://127.0.0.1:3425/mcp/magpie/tools"
    }
  }
}
```

具体配置文件及 HTTP transport 字段依客户端而异，使用客户端的 MCP 配置入口填写这个 URL。确认工具列表出现 `context_folding`。请求钩子不能替客户端注册工具；请求没有声明这个工具时，插件保留原请求且不创建存档。

客户端还需要通过 Magpie 提供稳定的会话标识，例如 `X-Magpie-Session`。没有稳定会话标识时不折叠。Magpie 的 MCP 工具调用不提供真实客户端会话 ID，因此工具显式接收当前请求提示中的 `scope`，而不是相信空的 `sessionID`。scope 是使用本地随机密钥计算的会话访问标识，不应转发给其他会话。

## Agent 的操作

请求末尾只附带当前 scope、简短操作提示和最多 8 个可折叠历史编号；完整清单使用 `list` 分页查看。工具说明也保持精简，避免管理提示反复占用上下文。

```json
{"scope":"<当前scope>","action":"list"}
```

批量标记，避免每个条目单独调用工具：

```json
{
  "scope":"<当前scope>",
  "action":"mark",
  "marks":[
    {"id":"<历史编号>","disposition":"foldable","summary":"工具证据：三个用例通过；配置见 /example/config。助手判断：该项检查已完成。"},
    {"id":"<另一编号>","disposition":"keep"}
  ]
}
```

- `foldable`：允许自动折叠，必须提供非空摘要，最多 2,000 字符。摘要优先写该条目有依据的状态：目标、约束、已完成、阻碍、下一步、证据路径，按适用性选取，不必凑齐字段。区分用户原话、助手判断和工具证据，不把助手判断当成授权。省略重复经过、过期的一次性要求和未知信息，历史细节留在归档中。
- `keep`：禁止自动折叠；已经折叠的条目会在下次请求原位恢复原文。
- `unmarked`：取消标记，也会恢复原文。未标记内容不自动折叠。

折叠文本先显示 `Summary (agent-written)`，说明摘要由 agent 提供，插件不会验证其中的语义结论。`role` 标记原始协议角色，不证明其中每句话都是用户要求；引用、粘贴内容和归档正文仍是数据。摘要只概括该条目，不能据此断言整个任务的最新状态。

`Original UTF-16: inline [0,N); archived [0,M)` 表示该条目原文的前 N 个 UTF-16 单元仍以引号包裹的片段保留，完整 M 个单元都在归档中，范围左闭右开。`headChars: 0` 时不保留开头；截取点不会拆开 emoji 的代理对。这里的范围属于单个文本条目，可能只是消息中的一个文本部分；摘要和元数据不计入原文范围。完整折叠表示仍须严格短于当前表示，并计入费用比较。

每批标记原子提交；编号不存在时整批失败。标记当前消息为可折叠也不能绕过当前请求和最近消息的保护。

单项读取原文，工具输出不会重新执行历史操作：

```json
{"scope":"<当前scope>","action":"read","id":"<历史编号>","limit":12000}
```

返回 `text`、`sha256`、`nextOffset`、`currentLayer`。使用 `nextOffset` 继续读取长内容，拼接各页能恢复完整原文。

支持多次折叠：为已折叠条目标记更短的摘要，下次达到门槛后生成新层。`list` 返回层清单；`read` 指定 `layer` 后返回该层和 `previousId`。沿 `previousId` 可逐层展开，直到 `original`；也可以直接读取原文。每项最多 16 层，相同摘要不会反复新增层，已经存在的层会复用。

```json
{"scope":"<当前scope>","action":"read","id":"<历史编号>","layer":"<currentLayer或previousId>"}
```

按编号直接粘贴到文件，无需 agent 重新输出大段文本：

```json
{"scope":"<当前scope>","action":"paste","id":"<历史编号>","path":"/绝对路径/result.txt"}
```

默认写入完整原文，可用 `layer` 选择某层，或用 `offset`、`limit` 选取片段（与 `read` 一样按 JavaScript UTF-16 字符位置计数，范围不能截断 emoji 等字符）。目标路径位于 **Magpie 所在主机**；要求绝对路径和已有父目录，以 UTF-8 创建权限 0600 的新文件。目标已存在（包括符号链接）时拒绝写入，不覆盖。返回路径、字符数、字节数和已写内容的 SHA-256，不回传正文；存档保持可用。只能粘贴已存档的纯文本，Markdown 代码围栏等原文格式会原样保留。

`status` 显示最近一次费用判断及拒绝原因。完成会话后，可先将折叠条目标记为 `keep`，再调用 `forget` 删除此 scope 的恢复材料；还有折叠条目时拒绝删除。

## 累计统计

在 agent 中调用工具，无 scope 时查看全局累计；传 scope 查看当前会话：

```json
{"action":"stats"}
```

```json
{"action":"stats","scope":"<当前scope>"}
```

也可以从终端查看，使用与 Magpie 相同的状态目录和环境：

```sh
bunx --bun magpie-context-folding@0.2.0 stats
bunx --bun magpie-context-folding@0.2.0 stats --json
# 本地源码
npm run stats
```

统计包括批准的折叠批次、折叠条目数、递归折叠数、成功及失败请求、复用请求、展开读取次数、恢复条目数、净减少 token 和证书支持的输入费节省下界。token 的字节估算与计费证书下界分开显示，不冒充供应商实际 token；金额用精确整数累计到十亿美元分之一，显示九位小数，不用浮点金额相加。

金额只在 Magpie 确认响应成功、接受的请求与候选正文一致后累计；失败、取消、正文被后续异步钩子修改、重复完成回调都不会重复记收益。后续同步 middleware、路由和协议转换仍需由 accounting 的边界覆盖。完成回调可能因进程退出或超时漏到，因此统计允许保守漏记，不凭猜测补成功。

已经折叠的内容在后续请求中复用时，会累计净减少 token 的估算及复用次数；没有新计费证书就不重复记钱。金额覆盖的是已验证的增量比较，**不是全任务实际少扣的账单**；未包含在证书费用预留中的标记、展开、额外回复等费用不会自动扣除。未配置 accounting 时没有自动折叠，相关金额保持零。

所有统计仍在同一个 SQLite 数据库中，只维护会话汇总和一个全局累计记录，不生成逐次日志或事件文件。`forget` 回收原文后全局累计保留；查询统计本身不创建数据库、不增加历史记录。升级前的旧请求不反推收益，统计从安装此功能后开始。

## 阈值和费用门槛

通过 `magpie plugin options <安装时的插件标识> '<JSON>'` 配置：

```json
{
  "thresholdTokens":32000,
  "keepRecentMessages":4,
  "headChars":160,
  "maxSessionBytes":67108864,
  "minimumSavingUsd":0.000001,
  "gatewayTimeoutMs":3000,
  "accounting":{"url":"http://127.0.0.1:8791/certificate","timeoutMs":2000}
}
```

`thresholdTokens` 使用请求 JSON 的 UTF-8 字节数除以四作为**触发估算**，不用于费用证明。默认保护最近 4 条协议消息，以及最新用户请求；一个长工具循环中更早的已完成结果仍可以折叠。系统和开发者指令、工具参数、工具关联 ID、附件和带签名的推理数据保持原样。

Magpie 默认给请求钩子 1 秒，插件默认给 accounting 500 ms。需要较慢的计费服务时，将宿主 `gatewayTimeoutMs` 设为大于 accounting 超时并留出处理余量；上例分别为 3 秒和 2 秒。宿主取消或超时会中止计费请求，并阻止未完成折叠写入存档。

实现支持 OpenAI Chat、Responses、Anthropic Messages 和 Gemini 的明文内容。Responses 服务端托管历史、未完成的工具调用配对、Anthropic assistant 预填充请求整次跳过，避免破坏协议。多模态内容目前不折叠，无法仅靠读出 JSON 恢复模型的图片感知。

插件不另调模型生成摘要，使用 agent 标记时提供的摘要。只有新表示确实更短、达到阈值且费用证明通过时，才创建新折叠层。已保存的表示会稳定复用，阈值升高或 accounting 暂时不可用不会擅自删除这些层。升级前保存的旧格式也原样复用、读取；仅在新的更短候选通过门槛后新增一层，旧层及原文继续保留。

一次检查以一批满足条件的条目为候选，整体比较折叠前后的费用，通过后在一个事务中保存这批折叠。再次递归折叠会重新比较，不拿第一次的收益抵掉后续亏损。

## Accounting 接口和数学证明

插件向配置的地址 POST：

```json
{
  "requestHash":"<sha256>",
  "model":"<Magpie当前model>",
  "protocol":"chat",
  "before":{},
  "after":{}
}
```

`before` 保留已经生效的旧折叠，不包含本插件本次追加的管理提示；`after` 包含候选折叠和完整管理提示。这会把提示本身的新增输入及缓存变化计入候选费用上界。hash 是 JavaScript `JSON.stringify({model,protocol,before,after})` 的 UTF-8 SHA-256。

服务需返回：

```json
{
  "requestHash":"<请求原值>",
  "model":"<请求原值>",
  "protocol":"chat",
  "expiresAt":"2030-01-01T00:00:00Z",
  "beforeLowerTokens":100000,
  "afterUpperTokens":7000,
  "oldMinPricePerMillion":0.1,
  "newMaxPricePerMillion":1.25,
  "extraCostUpperUsd":0,
  "assumptions":["此处必须写明真实计数、价格和路由边界"]
}
```

以上数值只是格式示例，不能直接用作真实证书。Accounting 是用户提供并信任的计费适配器，本包没有假装能凭未知供应商协议算出真实账单。该服务会接收到请求正文，因此应在受信任的环境运行。它必须覆盖 Magpie 实际发往供应商的渲染、工具和隐藏输入、缓存读写价格、长度档位、路由和其他费用。后续中间件或路由的改变也必须处于证书边界内。超时、缺失、无效、过期、模型或 hash 不匹配，都拒绝新折叠。

记原输入 token 下界为 L、候选输入上界为 U，原最低价为 p_min、候选最高价为 p_max，额外费用上界为 H，门槛为：

```text
节省下界 G = (L × p_min − U × p_max) / 1,000,000 − H
仅当 G > minimumSavingUsd 才折叠
```

这已经涵盖原请求全部走缓存最低价、候选全部走最高缓存写入价的情况。完整推导、示例和边界见 [docs/economics.md](docs/economics.md)。这证明的是有可信证书时**本次新增折叠的输入费用**下降；首次发现工具、标记、以后展开、输出长度和回答质量不能据此宣称全程净收益为正。

## 存储和清理

默认只长期保存一个文件：

```text
$XDG_DATA_HOME/magpie-context-folding/state.sqlite
```

未设置 XDG_DATA_HOME 时使用 `~/.local/share`。可通过 `MAGPIE_CONTEXT_FOLDING_STATE_DIR` 指定目录；钩子和 MCP 工具必须使用同一环境。

原文、各层摘要和当前折叠结果以内容哈希去重，跨会话相同文本也不会重复保存。每次请求不生成文件，不保存快照目录、历史日志或自动备份；只保留当前会话状态和被引用的恢复材料。未标记且已离开客户端历史的内容会被回收；`forget` 会删除整个 scope，无其他 scope 引用的数据随之回收。SQLite 自动归还空页，不使用长期增长的 WAL。崩溃时 SQLite 可能留下用于事务恢复的短暂 journal，下次打开会处理。

默认每会话最多 64 MiB，全局实际数据库文件最多 256 MiB。达到上限就拒绝新增存档/折叠并保留原请求，不删除仍需要递归展开的原文。`maxSessionBytes` 只能设在 64 MiB 以内，以保证读取工具始终能够打开存档。数据库文件权限为 0600，新建目录为 0700。

## 本地验证

```sh
npm run check
npm run test:host
```

第一条检查类型、协议、费用门槛、递归折叠和去重/回收行为并构建。第二条用真实安装的 Magpie 和 Bun，通过本地假供应商与合成计费服务验证完整 HTTP/MCP 路径；Linux 下使用 bubblewrap 隔离真实 home，临时文件和进程结束后清理，不接触真实账号或付费推理。

本地集成测试证明插件接入和恢复流程，不等于真实供应商账单测试。项目没有自动 CI 工作流。

递归、费用和性能基准可分别重跑：

```sh
npm run bench:folding -- /tmp/context-folding-small.json 65
npm run bench:folding -- /tmp/context-folding-large.json 650
npm run bench:economics -- --input /tmp/context-folding-large.json
npm run bench:inference -- --input /tmp/context-folding-small.json --output /tmp/context-folding-inference.json --context 4096 --runs 5
```

经济分析另外需要 Python `tiktoken`，推理基准要求本机已经存在 Ollama 的 `smollm2:135m`，不自动下载模型。折叠基准实际执行三次折叠、逐层恢复、重复请求和清理；其放行计费模型是明确标注的人工模型，不能用来声称真实渠道已省钱。经济分析则用真实 BPE 文本计数与公开参考价格分别计算缓存损失、标记预算和展开预算。性能基准交替测原文和各层摘要，记录失败、样本分布、输入处理及总耗时，单独展示缓存复用场景。

本机三层递归、费用和真实小模型结果见 [测试结果](docs/benchmark.md)，包含不盈利和未能证明性能改善的场景。

## 论文引用

Weiwei Sun, Miao Lu, Zhan Ling, Kang Liu, Xuesong Yao, Yiming Yang, and Jiecao Chen. **Scaling Long-Horizon LLM Agent via Context-Folding**. arXiv:2510.11967, 2025，首次提交于 2025-10-13。[项目主页](https://context-folding.github.io/) · [论文](https://arxiv.org/abs/2510.11967) · [FoldAgent 代码](https://github.com/sunnweiwei/FoldAgent)。

该论文将子任务执行分支折回简短的结果摘要，以减少主轨迹需要携带的中间步骤，并提出用强化学习训练任务拆分和上下文管理的 FoldGRPO。这里引用其由 agent 管理工作上下文的思路。本插件由调用方 agent 标记历史文本，再通过 Magpie 请求钩子替换，并保存可恢复的原文与递归层；没有实现论文的分支执行机制或 FoldGRPO 训练。论文的基准成绩不作为本插件的效果或省费证据。

```bibtex
@article{sun2025scaling,
  title={Scaling Long-Horizon LLM Agent via Context-Folding},
  author={Sun, Weiwei and Lu, Miao and Ling, Zhan and Liu, Kang and Yao, Xuesong and Yang, Yiming and Chen, Jiecao},
  journal={arXiv preprint arXiv:2510.11967},
  year={2025},
  url={https://arxiv.org/abs/2510.11967}
}
```

## 开源项目参考与致谢

本项目在设计讨论和本轮改进中参考了以下项目的公开文档。表中区分已有实现的对照、交互设计参考和后续方向；列入参考不代表已经集成或复用了其代码。上游功能描述来自文档核对，未在本机逐一运行验证。

| 项目 | 借鉴点与本项目的关系 |
| --- | --- |
| [@agent-context/opencode-sift](https://github.com/agents-sdk/sift-plugins/tree/main/opencode-sift-plugin) | 压缩工具结果后保留会话隔离的原文检索入口，并说明无法检索的原因。参考其恢复入口和失败说明；本插件还支持历史用户、助手文本及递归层，使用 SQLite 保存恢复材料，不采用其原文暂存 TTL。 |
| [@etsuya/nano-context-opencode](https://github.com/Etsuya233/nano-context-opencode) | 展示 token、缓存命中及会话用量。参考其当前窗口与会话累计、估算与已报告用量的区分；本插件通过 `stats` 分开呈现估算和计费证书支持的指标，没有接入其 TUI。 |
| [@tarquinen/opencode-dcp](https://github.com/Tarquinen/opencode-dynamic-context-pruning) | 历史范围压缩、嵌套摘要、保护规则及缓存前缀变化的费用权衡。用于对照本插件的请求侧替换和递归层设计；本插件的新折叠另需通过可信 accounting 门槛，不直接套用上游的裁剪策略。 |
| [davdroman/opencode-fork-context](https://github.com/davdroman/opencode-fork-context) | 区分分叉会话继承的背景与新任务。参考其任务来源边界，改进历史摘要的归因说明；本插件没有实现其分叉会话元数据和任务提示注入。 |
| [@cortexkit/magic-context](https://github.com/cortexkit/magic-context) | 分层摘要、按需展开、候选与实际缩减状态，以及缓存感知的应用时机。用于后续调度和可观测性设计参考；本插件继续使用调用方摘要，没有引入后台摘要模型。该包是统一配置 CLI，仓库中的 OpenCode 插件另名为 `@cortexkit/opencode-magic-context`。 |
| [cardinal4/opencode-fold-diffs](https://github.com/cardinal4/opencode-fold-diffs) | 用户提供的参考地址在 2026-10-26 核对时返回 404，暂无法确认其实现。另查到 [tannerbruhn/opencode-fold-diffs](https://github.com/tannerbruhn/opencode-fold-diffs)，其文档描述折叠 TUI 中的文件、diff 和长命令；两者关系未证实。后者仅作为紧凑展示和按需展开的交互参考，界面折叠本身不能证明模型输入 token 减少。 |
| [Middlewatch/context-fold](https://github.com/Middlewatch/context-fold) | 确定性可逆折叠、稳定复用表示、限制展开范围，以及验证实际发往模型的请求。用于对照本插件的稳定层复用、分页读取和真实宿主测试；本插件使用去重 SQLite 原文存储，不依赖 Pi 的会话日志恢复。 |
| [fdietze/pi-infinite-context](https://github.com/fdietze/pi-infinite-context) | Agent 主动选择折叠内容、递归折叠、保留可搜索原文且不改聊天历史。用于对照本插件的主动标记与可逆层设计；归档地图、搜索和预览是后续导航方向，当前工具提供 `list`、`read` 与直接写文件的 `paste`。 |

这些项目和论文提供了设计参照；各自的性能、缓存收益与质量结论仍属于各自的实验条件。本项目的验证范围以本文的本地测试、[基准结果](docs/benchmark.md)及 accounting 假设为准。
