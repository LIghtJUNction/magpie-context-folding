<p align="center">
  <img src="docs/assets/logo.png" alt="magpie-context-folding 折纸喜鹊 Logo" width="240" />
</p>

# magpie-context-folding

给 Magpie 提供可逆的上下文折叠。历史用户消息、模型回复和工具结果都能折叠，原文保持可读，不只是截断工具输出。

Agent 通过 `context_folding` 工具主动标注哪些内容可以折叠、哪些必须保留。达到阈值且费用门槛通过后，插件在发往模型的请求中将已标记内容替换成「简短摘要 + 来源角色及原文范围 + 开头片段 + 恢复入口」。客户端自己的完整历史不被改写。

默认以能力优先，使用最大智力模式，自动折叠较旧的大段工具输出；不依赖费用证明即可运行。原文始终可恢复。只有显式选择 `policy.mode="cost"` 或配置 accounting、费用边界、证书脚本时，才启用严格费用门槛。普通模式只承诺完整请求缩短，不把缩短估算当成实际账单节省。策略接口见 [docs/policy.md](docs/policy.md)。

## 四种模式

插件 options 使用 `{"mode":"intelligence"}`，TOML 使用 `[folding]` 下的 `mode`。默认值可用单项配置覆盖。

| mode | 名称 | 触发门槛估算 | 保留最近消息 | 自动选择 | 自动摘要上限 |
| --- | --- | ---: | ---: | --- | ---: |
| `intelligence` | 最大智力，默认 | 64K | 12 | 大段旧工具输出 | 1,600 字符 |
| `balanced` | 平衡 | 32K | 6 | 旧工具输出 | 800 字符 |
| `economy` | 最大经济 | 8K | 2 | 旧工具输出、旧助手回复 | 320 字符 |
| `agentic` | AI 自主切换 | 跟随当前策略 | 跟随当前策略 | 初始最大智力 | 跟随当前策略 |

AI 在 agentic 模式下调用 `{"action":"mode","scope":"<当前scope>","mode":"balanced"}` 等切换当前会话；不传 `mode` 则查询。下一次请求生效，其他会话不变。切回最大智力时，会重新评估自动折叠的内容，恢复最大经济模式自动收起的助手推理；显式 keep、unmarked 和手工摘要保留。模式不更换模型，也不配置模型窗口大小。最大经济侧重减少输入，不能保证未知供应商的最终账单最少。

某些客户端将 MCP 工具统一封装在代码执行工具内，外层请求不列出恢复工具。确认连接可用后，可在插件 options 设置 `recoveryToolName` 为真实工具名，或在 TOML 的 `[magpie]` 设置 `recovery_tool_name`。这是已验证恢复入口的声明；未声明也未直接提供恢复工具时，插件只加长度提示，不折叠。Codex code-mode 可使用 `mcp__magpie__magpie_context_folding_context_folding`。

项目还提供两项源码能力，由不依赖 Magpie 的 [context-folding 子项目](context-folding/README.md)实现：

- **注释标记控制代码细节自动折叠**：用整行注释 `@context-fold begin NAME` / `@context-fold end NAME` 指定区域，读取时归档内部原文并显示恢复引用，保留标记行与周边代码，源文件本身不变。Python 还支持自动发现函数、类和复合块；[标记与读取示例](context-folding/README.md#source-annotations-and-compact-reads)。
- **透明折叠也支持编辑**：agent 可以直接用读到的 `[[cf:v1:…]]` 引用指代完整代码块，例如放进替换工具的 `old_string`。宿主在执行前解析整个最终参数 JSON，还原精确原文，再交给目标工具进行正常审批、当前文件匹配与替换；[透明替换示例](context-folding/README.md#transparent-editing-with-folded-references)。

通用实现提供 Python SDK、CLI、JSON Lines RPC、MCP stdio，以及 Rust、TypeScript、C# 的持久 Python 桥接客户端。它与本页的 Magpie 插件是两套集成；通用实现由宿主显式应用渲染结果、解析工具参数引用，不使用本插件的 accounting 门槛。根插件目前没有自动接入这些源码注解和工具参数解析能力；单独启动 MCP 服务也不会拦截其他工具调用。

## 安装和连接工具

当前源码版本为 `0.3.0`，尚未发布；npm 最后已知发布版本为 `0.2.0`。本页描述当前源码的分组树、检索浏览、文件版本与相似历史导航、分层配置、请求预算及 CLI，不代表这些能力都已包含在 `0.2.0` 中。需要本页所述能力时，从仓库根目录安装本地源码：

```sh
npm ci
npm run check
magpie plugin add /绝对路径/magpie-context-folding
```

开发检查需要 Bun >= 1.4.0、Node.js >= 22 和 npm。Magpie 使用 Bun 直接加载包内 TypeScript 源码，不依赖安装时构建脚本，也不需要在源码仓库保存重复的编译产物。根 npm 包只包含 Magpie 插件，不包含通用 Python/SDK 子项目或独立 skill；通用实现按自己的 README 单独安装。

请求 guide 已附带一行按需安装提示：[source-fold-markers skill 目录](https://github.com/LIghtJUNction/magpie-context-folding/tree/main/context-folding/skills/source-fold-markers)——稳定、已验证的代码可用此技能添加默认折叠标记，把整个目录复制到宿主已发现的 skills 目录。该提示按需引导 agent 获取完整说明，不自动安装 skill，也不修改宿主配置；这一行的输入开销包含在费用候选中。

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

具体配置文件及 HTTP transport 字段依客户端而异，使用客户端的 MCP 配置入口填写这个 URL。确认工具列表出现 `context_folding`。请求钩子不能替客户端注册工具；请求既未声明这个工具也未配置已核实的 recoveryToolName 时，不创建存档或执行折叠，仍为可安全处理的请求附加预算提示。

客户端还需要通过 Magpie 提供稳定的会话标识，例如 `X-Magpie-Session`。没有稳定会话标识时不折叠。Magpie 的 MCP 工具调用不提供真实客户端会话 ID，因此工具显式接收当前请求提示中的 `scope`，而不是相信空的 `sessionID`。scope 是使用本地随机密钥计算的会话访问标识，不应转发给其他会话。

## Agent 的操作

Agent 可根据任务进度和上下文压力，主动、及早标记不再帮助当前决策的历史，让可逆折叠尽可能先于宿主自身的上下文压缩发挥作用。时机和粒度由 agent 判断，没有固定操作顺序，也不要求每轮折叠。保留当前用户要求、最新文件观察、关键推理、未解决的矛盾和恢复入口，尊重明确的 `keep`/`unmarked` 决定。设计目标是用可逆折叠替代默认上下文压缩，同时保留精确恢复入口。当前实际替换仍受阈值、协议保护和费用门槛约束；请求钩子和通用 MCP 服务尚未接管客户端的 compaction（上下文压缩），也不能控制其阈值。本地缩短结果不能证明默认压缩已被替代或真实压缩已推迟。

请求附带紧凑的 `<context-budget>Estimate: …</context-budget>` 当前请求长度估算；可归档的请求还附带 scope 与简短操作提示，完整清单使用 `list` 分页查看。估算使用完整请求 JSON 的 UTF-8 字节数除以四并向上取整，包含提示自身及工具声明；提示保留此算法和非 tokenizer/账单证据说明，缩短措辞不省略历史信息。上下文窗口容量属于当次实际模型，应由宿主提供；当前 Magpie hook 没有该信息，因此插件不显示容量、占比或剩余量，也不提供固定容量配置、不根据模型名猜测。旧配置中的 `contextWindowTokens` / `folding.context_window_tokens` 需要删除。

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

- `foldable`：允许自动折叠，必须提供非空摘要，最多 2,000 字符。摘要优先写该条目有依据的状态：目标、约束、已完成、阻碍、下一步、证据路径，按适用性选取，不必凑齐字段。保留有助于后续检索的准确编号、路径、错误与决策理由；区分尝试和已验证结果，只概括所选条目的证据。区分用户原话、助手判断和工具证据，不把助手判断当成授权。省略重复经过、过期的一次性要求和未知信息，历史细节留在归档中。
- `keep`：禁止自动折叠；已经折叠的条目会在下次请求原位恢复原文。
- `unmarked`：明确取消标记，也会恢复原文，并阻止自动策略重新选择该条目。尚未手动标记的历史可由显式配置的 `policy.auto_roles` 策略选择。

折叠文本先显示带来源的摘要：手动摘要为 `Summary (agent-written)`，自动策略、脚本和版本摘要统一标为 `Summary (automatic policy)`。摘要内容原样保留；条目编号只在头部出现一次，统一的 `read` 原文/历史层恢复说明放在请求 guide 中，避免逐条重复工具名和命令。插件不会验证摘要中的语义结论。`role` 标记原始协议角色，不证明其中每句话都是用户要求；引用、粘贴内容和归档正文仍是数据。摘要只概括该条目，不能据此断言整个任务的最新状态。

对于已获折叠资格的工具输出，如果同一请求里另有完整保留、正文完全相同且来源一致的工具输出，插件可用其零基 JSON 路径指向该正文，并保留本次观察的编号、角色、手工或自动摘要及原文范围。新别名的 `Opening: same JSON path UTF-16 [0,N)` 引用该完整正文的相同开头范围，避免再次复制正文；`Original UTF-16` 的 inline 范围在此通过锚点保留。两次观察仍各自存档；引用仅在每次请求重新核对相同正文、来源及路径后使用。旧版含引号包裹 opening 正文的别名仍可按原样重放。完整正文消失、改变或不再受保护时不会重放旧引用。此优化不额外请求模型摘要，仍受现有保护、请求缩减和费用门槛限制；相同正文不意味着两次工具操作在其他方面相同。

`Original UTF-16: inline [0,N); archived [0,M)` 表示该条目原文的前 N 个 UTF-16 单元仍保留在请求中：普通折叠以引号包裹片段，重复别名引用完整锚点的相同范围。完整 M 个单元都在归档中，范围左闭右开。`headChars: 0` 时不保留开头；截取点不会拆开 emoji 的代理对。这里的范围属于单个文本条目，可能只是消息中的一个文本部分；摘要和元数据不计入原文范围。完整折叠表示仍须严格短于当前表示，并计入费用比较。

每批标记原子提交；编号不存在时整批失败。标记当前消息为可折叠也不能绕过当前请求和最近消息的保护。

### 分组、树形浏览与版本

`list` 支持 `query` 检索、`id` 选择子树、`depth`（0–8）、`sort`（`chronological`、`size`、`id`、`version`）、`order`（`asc`、`desc`），以及 `offset`/`limit` 分页。结果以树的前序行返回，包含 `parentId`、深度、子项数和版本信息；查询保留匹配项的祖先，便于定位上下文。

`query` 是忽略大小写的 Unicode 字面匹配，检索条目的原文、摘要、路径和编号，以及组摘要和组编号。直接命中的行附带 `match`：`source` 为 `original`、`summary`、`path` 或 `id`，`offset`/`endOffset` 是该字段内首次命中的左闭右开 UTF-16 范围，`excerptOffset` 是 `excerpt` 在该字段中的起点。片段最多 240 个 UTF-16 单元，边界不拆开 emoji，保留原始换行；只为导航保留的祖先没有 `match`。同一条目多字段命中时优先返回原文，其次摘要、路径、编号；组优先摘要，其次编号。仅摘要命中不证明原文含有该词。

对 `source: "original"`，可把 `match.offset` 直接传给 `read` 继续查看证据；其他来源的偏移不能用于原文定位。`list` 搜索不会改变折叠状态或持久标记 `keep`；`read` 默认仍会保护原文，仅观察时使用 `peek:true`。用 `nextOffset` 翻页；深度不足时可用祖先编号作为 `id` 继续向下浏览。

```json
{"scope":"<当前scope>","action":"list","query":"配置","depth":2,"sort":"size","order":"desc","limit":20}
```

分组通过 `mark` 中的 `ids` 创建，而不是单独的 `group` action。每组包含 2–100 个不同子项，可嵌套；每个子项最多属于一个父组。由 agent 为相关历史编写组摘要：

```json
{"scope":"<当前scope>","action":"mark","marks":[{"ids":["<编号A>","<编号B>"],"disposition":"foldable","summary":"工具证据：这轮旧排查已完成，原始输出保留在子项中。"}]}
```

组不能绕过后代中的用户内容、`keep`、明确手动 `unmarked`、最新版本或当前请求保护。真正应用时仍须更短且通过费用门槛。组摘要首行包含组编号及首个子项的编号、角色；其余子项各自保留组编号、子项编号、角色和摘要位置，恢复说明共用 guide。组的 `read`/`paste` 返回摘要和子项编号组成的 manifest；读取子项才能得到各自原文和已有历史层。组本身仍只有 manifest，不新增组级历史层。将某个子项改为 `keep` 或 `unmarked` 会禁用其上层组，避免恢复后又被父摘要遮住。

文件历史按来源路径和读取范围关联版本，最新观察受保护；旧观察可保留旧版独有行作为摘要，并通过版本链接恢复。长且高度相似、没有文件来源的输出也可形成相似历史系列，但相似仅用于导航，不证明语义替代关系。自动摘要不覆盖明确的手动决定，`keep` 和手动 `unmarked` 仍有效。文件版本链与同一条目多次折叠形成的层链是两种关系。

### 读取与恢复

单项读取原文，工具输出不会重新执行历史操作：

```json
{"scope":"<当前scope>","action":"read","id":"<历史编号>","limit":12000}
```

返回 `text`、`sha256`、`nextOffset`、`currentLayer`。使用 `nextOffset` 继续读取长内容，拼接各页能恢复完整原文。

`read` 和 `paste` 默认将条目持久标记为 `keep`，即使只读取一页或某个历史层也一样；同时禁用版本自动折叠并展开所有祖先组。后续请求持续发送原文，只有显式重新 `mark foldable` 才恢复折叠资格。仅检查内容而保留当前折叠状态时，传 `"peek":true`（CLI 为 `--peek`）。`paste` 在写目标文件前保护原文，目标已存在等写入失败也可能保留该保护。

支持多次折叠：为已折叠条目标记更短的摘要，下次达到门槛后生成新层。`list` 返回层清单；`read` 指定 `layer` 后返回该层和 `previousId`。沿 `previousId` 可逐层展开，直到 `original`；也可以直接读取原文。每项最多 16 层，相同摘要不会反复新增层，已经存在的层会复用。旧格式缓存继续回放；仅删除重复元数据得到更小表示时，也要重新通过阈值、完整请求缩减和所配置的费用门槛，再保存新层，已有历史层不改写。

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
# 从当前仓库根目录运行本地源码
npm run stats
npm run stats -- --json
```

统计首先展示三项累计值：**折叠次数、查看详情次数、累计折叠 token（估算）**。每批新批准的折叠计一次，递归折叠也计入；查看详情按成功读取原文或历史层的调用次数计数，失败读取不计入。累计折叠 token 按每批新折叠前后完整请求的 UTF-8 字节数除以四估算并累加，复用已有折叠不重复计入；旧版本未记录该项的历史不反推。显示自动使用十进制单位：`1K = 1,000`、`1M = 1,000,000`、`1B = 1,000,000,000`，最多两位小数；JSON 的 `summary` 同时保留精确累计整数和显示值。

统计还包括折叠条目数、递归折叠数、成功及失败请求、复用请求、恢复条目数、成功请求的累计净减少 token 和证书假设下的节省下界累计。token 的字节估算与计费证书下界分开显示，不冒充供应商实际 token；金额用精确整数累计到十亿美元分之一，显示九位小数，不用浮点金额相加。

金额只在 Magpie 确认响应成功、接受的请求与候选正文一致后累计；失败、取消、正文被后续异步钩子修改、重复完成回调都不会重复记收益。后续同步 middleware、路由和协议转换仍需由 accounting 的边界覆盖。完成回调可能因进程退出或超时漏到，因此统计允许保守漏记，不凭猜测补成功。

已经折叠的内容在后续请求中复用时，会累计净减少 token 的估算及复用次数；没有新计费证书就不重复记钱。当前证书必须覆盖相对不折叠完成同一任务的全部新增工作，包括工具调用、模型往返、历史和工具结果的再次输入、摘要与工具参数输出、恢复原文及工具直接费用。金额依赖这些边界假设，**不是全任务实际少扣的账单**；历史累计保留原证据限制，不升级为完整任务收益证明。选择 cost 模式且没有可信费用证据时拒绝新增折叠；证据也可由证书脚本或配置的保守费用边界提供。显式 bytes 模式只记录缩减估算，不认证金额。

所有统计仍在同一个 SQLite 数据库中，只维护会话汇总和一个全局累计记录，不生成逐次日志或事件文件。`forget` 回收原文后全局累计保留；查询统计本身不创建数据库、不增加历史记录。升级前的旧请求不反推收益，统计从安装此功能后开始。

## CLI 与分层配置

根包提供 `read`、`paste`、`mark`、`list`、`status`、`mode`、`config`、`stats` 和 `report`。在与 Magpie 相同的状态目录和环境中运行，scope 使用请求提示中的值。`read` 默认向标准输出写正文；归档查询和修改默认返回 JSON，`stats` 默认便于终端阅读，加 `--json` 可供程序处理。

```sh
# 本地源码示例；安装后可使用 magpie-context-folding 命令
bun src/cli.ts list --scope "$SCOPE" --json
bun src/cli.ts read --scope "$SCOPE" --id "$ID" --peek | sha256sum
bun src/cli.ts paste --scope "$SCOPE" --id "$ID" --path /绝对路径/result.txt
printf '%s\n' '[{"id":"条目编号","disposition":"keep"}]' | bun src/cli.ts mark --scope "$SCOPE" --marks -
bun src/cli.ts config --project-dir "$PWD" --json
bun src/cli.ts report --output /绝对路径/folding-effects.html
```

`report` 导出单文件离线页面，可看当前归档、最后候选前后字节、累计统计、费用证据及“下一步查什么”。用浏览器打开即可，支持浅深色、纹理、悬停或键盘查看数值及数据表。缺少记录时明确显示证据不足，不补画效果。输出必须是尚不存在的绝对路径，文件权限为 0600；报告只读且隐藏原文、路径和会话标识。具体调试步骤见 [可视化与调试](docs/visualization.md)。

配置按内置默认值、全局 TOML、项目 TOML、显式插件 options 的顺序合并；对象逐字段合并，数组整体替换。全局文件为 `$XDG_CONFIG_HOME/context-folding/config.toml`，未设置时使用 `~/.config/context-folding/config.toml`。项目文件为最近祖先目录的 `.context-folding.toml`，查找到 `.git` 边界即停止。CLI `config` 显示生效配置和来源路径，并隐藏 accounting URL 与脚本命令；恢复操作仍可在 `enabled=false` 时使用。

```toml
version = 1
[folding]
mode = "intelligence" # intelligence / balanced / economy / agentic
enabled = true

[policy]
mode = "bytes" # 默认仅检查完整请求缩短；可显式 cost 启用费用证明门槛
```

可信本地脚本可产生候选摘要或费用证书，配置和输入/输出约束见 [策略文档](docs/policy.md)。脚本是用户信任的本地程序，使用绝对 executable 和 argv，运行时不经过 shell；它并非沙箱。

## 阈值和费用门槛

通过 `magpie plugin options <安装时的插件标识> '<JSON>'` 配置，字段使用 camelCase：

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

插件不自行调用模型生成摘要。默认使用 agent 标记的摘要，也可显式配置确定性的自动候选或可信本地脚本。只有新表示确实更短、达到阈值且费用证明通过时，才创建新折叠层。已保存的表示会稳定复用，阈值升高或 accounting 暂时不可用不会擅自删除这些层。升级前保存的旧格式也原样复用、读取；仅在新的更短候选通过门槛后新增一层，旧层及原文继续保留。

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
  "incremental":{
    "toolCalls":1,
    "modelRoundTrips":1,
    "inputTokens":1000,
    "outputTokens":100,
    "inputPricePerMillion":1.25,
    "outputPricePerMillion":5,
    "toolFeesUsd":0.001
  },
  "assumptions":["此处必须写明真实计数、价格、路由及同一任务全部新增工作边界"]
}
```

以上数值只是格式示例，不能直接用作真实证书。Accounting 是用户提供并信任的计费适配器，本包没有假装能凭未知供应商协议算出真实账单。该服务会接收到请求正文，因此应在受信任的环境运行。它必须覆盖 Magpie 实际发往供应商的渲染、工具和隐藏输入、缓存读写价格、长度档位、路由和其他费用。后续中间件或路由的改变也必须处于证书边界内。超时、缺失、无效、过期、模型或 hash 不匹配，都拒绝新折叠。

记原输入 token 下界为 L、候选输入上界为 U，原最低价为 p_min、候选最高价为 p_max，额外费用上界为 H，门槛为：

```text
节省下界 G = (L × p_min − U × p_max) / 1,000,000 − H
仅当 G > minimumSavingUsd 才折叠
```

H 包含 `extraCostUpperUsd`、`incremental.toolFeesUsd`，以及 incremental 合计输入、输出 token 按各自价格上界计算的费用。次数描述同一任务新增的工具调用和模型往返，合计金额不再乘次数，也不假设工具统一按次收费。配置中的旧 overhead/output/restore 预留与 incremental 必须互不重叠；未知边界不能填零，已发生的输出属于沉没成本。

这涵盖原请求全部走缓存最低价、候选全部走最高适用价格的情况。完整推导、示例和边界见 [docs/economics.md](docs/economics.md)。只有可信证书同时覆盖下一次完整输入及同一任务全部新增工作时，才得到这些假设下的费用节省下界；多一次工具调用或模型往返可能抵消输入节省。它不证明实际账单下降或回答质量提升。

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

经济分析另外需要 Python `tiktoken`，推理基准要求本机已经存在 Ollama 的 `smollm2:135m`，不自动下载模型。折叠基准实际执行三次折叠、逐层恢复、重复请求和清理；其放行计费模型是明确标注的人工模型，不能用来声称真实渠道已省钱。经济分析的 schema 2 用 BPE 文本计数与参考价格展示局部比较和 `full_work_cost`：完整成本还须显式提供标记、旧预留及 incremental 七项边界，缺任一项显示 `unknown`，不默认零。额外调用次数不再乘合计 token 或工具费。这仍不等于供应商完整渲染、实际账单或全任务实验证据。性能基准交替测原文和各层摘要，记录失败、样本分布、输入处理及总耗时，单独展示缓存复用场景。

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

本项目在设计讨论和改进中参考了以下项目的公开文档与部分源码。表中区分已有实现的对照、交互设计参考和后续方向；列入参考不代表已经集成或复用了其代码。上游功能描述来自文档与所列源码核对，未在本机逐一运行验证。

| 项目 | 借鉴点与本项目的关系 |
| --- | --- |
| [@agent-context/opencode-sift](https://github.com/agents-sdk/sift-plugins/tree/main/opencode-sift-plugin) | 压缩工具结果后保留会话隔离的原文检索入口，并说明无法检索的原因。参考其恢复入口和失败说明；本插件还支持历史用户、助手文本及递归层，使用 SQLite 保存恢复材料，不采用其原文暂存 TTL。 |
| [@etsuya/nano-context-opencode](https://github.com/Etsuya233/nano-context-opencode) | 展示 token、缓存命中及会话用量。参考其当前窗口与会话累计、估算与已报告用量的区分；本插件通过 `stats` 分开呈现估算和计费证书支持的指标，没有接入其 TUI。 |
| [@tarquinen/opencode-dcp](https://github.com/Tarquinen/opencode-dynamic-context-pruning) | 历史范围压缩、嵌套摘要、保护规则及缓存前缀变化的费用权衡。用于对照本插件的请求侧替换和递归层设计；本插件的新折叠另需通过可信 accounting 门槛，不直接套用上游的裁剪策略。 |
| [davdroman/opencode-fork-context](https://github.com/davdroman/opencode-fork-context) | 区分分叉会话继承的背景与新任务。参考其任务来源边界，改进历史摘要的归因说明；本插件没有实现其分叉会话元数据和任务提示注入。 |
| [@cortexkit/magic-context](https://github.com/cortexkit/magic-context) | 分层摘要、按需展开、候选与实际缩减状态，以及缓存感知的应用时机。用于后续调度和可观测性设计参考；本插件继续使用调用方摘要，没有引入后台摘要模型。该包是统一配置 CLI，仓库中的 OpenCode 插件另名为 `@cortexkit/opencode-magic-context`。 |
| [cardinal4/opencode-fold-diffs](https://github.com/cardinal4/opencode-fold-diffs) | 用户提供的参考地址在 2026-10-26 核对时返回 404，暂无法确认其实现。另查到 [tannerbruhn/opencode-fold-diffs](https://github.com/tannerbruhn/opencode-fold-diffs)，其文档描述折叠 TUI 中的文件、diff 和长命令；两者关系未证实。后者仅作为紧凑展示和按需展开的交互参考，界面折叠本身不能证明模型输入 token 减少。 |
| [Middlewatch/context-fold](https://github.com/Middlewatch/context-fold) | 确定性可逆折叠、稳定复用表示、限制展开范围，以及验证实际发往模型的请求。用于对照本插件的稳定层复用、分页读取和真实宿主测试；本插件使用去重 SQLite 原文存储，不依赖 Pi 的会话日志恢复。 |
| [fdietze/pi-infinite-context](https://github.com/fdietze/pi-infinite-context) | Agent 主动选择折叠内容、递归折叠、保留可搜索原文且不改聊天历史。用于对照本插件的主动标记与可逆层设计；当前 main 增加分组树、`list` 查询/子树浏览及版本导航，原文由 `read` 与直接写文件的 `paste` 恢复，尚未实现上游完整的归档地图界面。 |
| [jonaslsaa/pi-optchat](https://github.com/jonaslsaa/pi-optchat/tree/2714a3f4167ba41ea1868b51d715e680ac5f095d) | 核对提交 `2714a3f` 的[原文检索](https://github.com/jonaslsaa/pi-optchat/blob/2714a3f4167ba41ea1868b51d715e680ac5f095d/src/memory.ts#L404-L413)与[命中片段、展开导航](https://github.com/jonaslsaa/pi-optchat/blob/2714a3f4167ba41ea1868b51d715e680ac5f095d/src/tools.ts#L7-L65)。借鉴“先检索片段，再按编号读取”的路径，本项目独立实现 `list.match`，增加来源标签、精确 UTF-16 偏移及组编号检索；继续保留 SQLite 原文、稳定折叠层重放、尾部提示与完整请求费用门槛。没有接入其后台摘要、缓存标记重写或 Git checkpoint，也未运行上游。 |

pi-optchat 的[许可证](https://github.com/jonaslsaa/pi-optchat/blob/2714a3f4167ba41ea1868b51d715e680ac5f095d/LICENSE#L1-L25)为 MIT，但明确排除 `src/prompts.ts` 中归属上游的提示词及独立授权依赖；[第三方声明](https://github.com/jonaslsaa/pi-optchat/blob/2714a3f4167ba41ea1868b51d715e680ac5f095d/THIRD_PARTY_NOTICES.md#L5-L12)说明这些提示词未被重新授权。本轮仅参考设计思路，搜索实现和摘要指导均独立编写，没有复制其提示词。

这些项目和论文提供了设计参照；各自的性能、缓存收益与质量结论仍属于各自的实验条件。本项目的验证范围以本文的本地测试、[基准结果](docs/benchmark.md)及 accounting 假设为准。
