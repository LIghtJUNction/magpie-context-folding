# magpie-context-folding

给 Magpie 提供可逆的上下文折叠。历史用户消息、模型回复和工具结果都能折叠，原文保持可读，不只是截断工具输出。

Agent 通过 `context_folding` 工具主动标注哪些内容可以折叠、哪些必须保留。达到阈值且费用门槛通过后，插件在发往模型的请求中将已标记内容替换成「开头 + 精简结果 + 原文编号」。客户端自己的完整历史不被改写。

**默认没有可信计费数据时不执行自动折叠。** 本项目不把字符估算或假定未来轮数当成省钱证明。可先使用标记、查看和状态功能；自动折叠需要配置下述 accounting 服务。

## 安装和连接工具

直接安装已发布的版本：

```sh
magpie plugin add 'npm:magpie-context-folding@0.1.0'
# 也可以安装 GitHub 的固定版本
magpie plugin add 'github:LIghtJUNction/magpie-context-folding#v0.1.0'
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

请求末尾会附带当前 scope 和一小段历史编号清单。完整清单使用 `list` 分页查看。

```json
{"scope":"<当前scope>","action":"list"}
```

批量标记，避免每个条目单独调用工具：

```json
{
  "scope":"<当前scope>",
  "action":"mark",
  "marks":[
    {"id":"<历史编号>","disposition":"foldable","summary":"检查已完成：三个用例通过，配置文件位于 /example/config。"},
    {"id":"<另一编号>","disposition":"keep"}
  ]
}
```

- `foldable`：允许自动折叠，必须提供非空摘要，最多 2,000 字符。摘要应保留结果、尚未解决的问题和后续需要的引用。
- `keep`：禁止自动折叠；已经折叠的条目会在下次请求原位恢复原文。
- `unmarked`：取消标记，也会恢复原文。未标记内容不自动折叠。

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

`status` 显示最近一次费用判断及拒绝原因。完成会话后，可先将折叠条目标记为 `keep`，再调用 `forget` 删除此 scope 的恢复材料；还有折叠条目时拒绝删除。

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

插件不另调模型生成摘要，使用 agent 标记时提供的摘要。只有新表示确实更短、达到阈值且费用证明通过时，才创建新折叠层。已保存的表示会稳定复用，阈值升高或 accounting 暂时不可用不会擅自删除这些层。

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
