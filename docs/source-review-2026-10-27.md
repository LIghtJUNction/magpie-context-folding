> **历史材料（0.3.x 及更早实现）。** 本文记录旧摘要、自动策略或此前验证，不描述 0.4.0 的注释主动折叠。旧命令、配置和数值不构成新实现的使用说明或效果证明；当前协议见 [annotation-protocol.md](annotation-protocol.md)。

# 源码审查与修复：恢复入口、原文保真、会话配额

日期：2026-10-27（Asia/Taipei）

基线：`main` / `17db179e0161c94d893102b8a0a873a690835651`

这个项目的核心操作是把原文保存起来，用较短的表示替换请求中的历史，再通过引用恢复原文。本轮针对这条链路审查并修复五类实际问题；每项都有旧实现失败的回归证据。没有更改费用计算模型或声称实际账单已经减少。

## 已修复问题

### 1. 没有可调用的恢复工具，也会折叠原文

位置：[`src/context.hooks.ts`](../src/context.hooks.ts) 的 `onRequest`，以及新增的 [`src/protocol.ts`](../src/protocol.ts) / `recoveryToolName`。

原检测只执行：

```ts
JSON.stringify(body.tools ?? body.config ?? {}).includes('context_folding')
```

无关工具的描述、参数字段或相似名字包含这段文字，就会被当成恢复入口。另一方面，工具虽然已声明，但请求设置了 `tool_choice: "none"`、强制选择其他工具、或允许列表排除了恢复工具时，原实现仍会折叠。已存的折叠也会继续重放。原文没有从客户端历史或归档中永久删除，但模型当次看到的是被收起的内容，并且无法按提示调用恢复工具。

修复后按 Chat、Responses、Anthropic、Gemini 各自的真实函数声明取名字，并检查当次调用限制。自动识别仅接受 `context_folding` 和已知的完整 Magpie MCP 名字；恢复提示使用实际发现的名字。显式 `recoveryToolName` 继续支持已核实的代码执行包装器，但全局禁用工具时仍保留原文。

验证：[`test/recovery-tool.test.ts`](../test/recovery-tool.test.ts) 的 21 个端到端测试在旧版全部失败，修复后全部通过，覆盖误判、禁用、允许列表、MCP 名字、旧折叠暂停与重新启用。修正了原有跨协议测试中错误复用 Chat 工具格式的夹具，原业务断言保留。

### 2. 源码中的普通引用字符串，会在恢复时被替换成其他内容

位置：[`context-folding/python/context_folding/annotations.py`](../context-folding/python/context_folding/annotations.py) 的 `compact_source`、`fold_regions`，以及 [`core.py`](../context-folding/python/context_folding/core.py) 的 `_read`。

复现方式：先保存一段无关文本，取得它的引用；再把该引用作为普通字符串放在源码可见部分，后面放一个可折叠函数。

```python
literal = "[[cf:v1:某个已有条目的实际ID]]"
def work():
    # 足够长的函数体
    ...
```

旧版生成的 compact view 保留第一行，`resolve` 随后把其中的引用当成恢复指令，第一行变成无关存档正文。如果 ID 不存在，则整次恢复失败。这违反完整 compact view 恢复精确原文的承诺。

本轮没有引入新的引用协议：生成 folded view 前检查实际保留的原文片段。若它们含保留前缀 `[[cf:`，明确拒绝并提示 `mode='original'`。已经隐藏在归档 payload 内的文字仍允许，因为 `resolve` 只展开一次，恢复出来的内容不会再次解释。原文模式和完整原文条目的引用仍可使用。

旧 `fold_regions` 适配器先验证全部可见片段，再进行任何 `put`，避免发现末尾歧义前已经写入部分归档。SDK 保留现有 `invalid_request` 错误码，只对这个专门错误提供固定操作提示，不泄漏源文本。

验证：[`test_reference_literals.py`](../context-folding/tests/test_reference_literals.py) 的 6 个方法覆盖已有引用、缺失引用、格式错误前缀、keep/展开后可见、隐藏 payload 单次展开、事务回滚及 legacy 零写入。旧版出现 33 个失败子项；修复后全部通过。LF、CRLF、CR 和无末尾换行均覆盖。

### 3. 工具操作悄悄把用户的会话限额改回 64 MiB

位置：[`src/store.ts`](../src/store.ts) 的 `transaction`，以及 [`src/tool.ts`](../src/tool.ts) 的恢复与标记入口。

实际复现：请求使用 `maxSessionBytes=2048` 建档，随后 `mark` 写入 1,900 字符摘要。旧版工具重新读取缺少原请求覆盖项的配置，允许归档超过 2 KiB，并把保存的限额改成 `67108864`。普通默认 `read` 写入 keep 保护时也会抬高这个限额。

修复将两件事分开：

- 请求入口的 `configure` 可以有意调整持久配额。
- 恢复和查看使用 `preserve`，本次操作上限不会覆盖持久配额。
- 新增 foldable 标记使用 `enforce`，同时遵守操作上限和已保存的会话配额。

仅配置限额变化、其他归档内容不变时，也会提交新限额。交叉复审还补上了旧档案缺少 `sessionLimitBytes` 时的迁移回归，防止再次回退到 64 MiB。配置降低不会删除已有原文；仍允许等大或缩小操作。统计写入继续使用保存的限额。

验证：[`test/session-quota.test.ts`](../test/session-quota.test.ts) 覆盖真实 `onRequest` 建档、超额标记的原子拒绝、读取不抬限、主动提高与降低限额、旧档案默认兼容和配置迁移。核心四项在旧版全部失败，旧档案配置迁移另行验证先失败再通过。原有并发快照检查保留。

### 4. 重新启用分组成功，随后却无法读取

位置：[`core.py`](../context-folding/python/context_folding/core.py) 的 `_group`。

旧版复用相同分组时只写 `enabled=True`，没有清除 `trashedAt`，也没有刷新 `lastUsedAt`。因此回收站中的组返回成功引用后仍报 `not_found`；长期闲置的组还可能在复用成功的同一次调用结束前再次被自动回收。

修复清除已有组的回收标记并刷新使用时间。仍验证全部子项；已回收或受保护的子项会使请求原子失败。没有改变生命周期 roots 的管理责任。

验证：[`test_core.py`](../context-folding/tests/test_core.py) 增加复用回收组、自动回收时间和受保护/已回收子项三项回归。旧实现出现失败和错误，修复后通过。

### 5. `js` / `ts` 被误判为改变语言，已有存档依赖重新解析

位置：[`core.py`](../context-folding/python/context_folding/core.py) 的 `_source`。

归档保存 `javascript` / `typescript`，旧版比较缓存时没有把 `js` / `ts` 归一化。每次通过别名读取都触发重新解析，卸载可选解析器后，已有存档也无法通过别名读取。

修复在比较前复用现有 `normalize_language`。没有新增解析器或第三方依赖。

验证：[`test_annotations.py`](../context-folding/tests/test_annotations.py) 覆盖大小写别名及可选解析器缺失时的存档复用；旧版四个别名子项失败，修复后通过。

## 完整验证

运行环境：Bun 1.4.4、Node.js 24.22.1、Python 3.12.14；npm 使用仓库 lockfile，Python 使用 `uv sync --locked --extra javascript`。

| 验证 | 基线 | 修复后 |
| --- | ---: | ---: |
| TypeScript 主项目 | 208 通过 | 235 通过，0 失败 |
| Python，含可选 JS/TS 解析器 | 142 通过 | 152 通过，0 失败 |
| Node TypeScript 桥接 + Pi 适配器，连接真实 Python 核心 | 未作为基线指标 | 11 通过，1 跳过，0 失败 |
| TypeScript 类型检查与构建 | 通过 | 通过 |
| 补丁空白/冲突标记检查 | — | `git diff --check` 通过 |

修复后共 **398 个测试通过、1 个跳过**。跳过项要求已安装的 Pi 宿主及 `PI_PACKAGE_ROOT`，因此不宣称完整 Pi 宿主验收完成。

复验命令：

```sh
npm ci
npm run check
uv sync --project context-folding --locked --extra javascript
uv run --project context-folding --locked python -m unittest discover -s context-folding/tests -v
npm run build --prefix context-folding/sdks/typescript
CONTEXT_FOLDING_REAL_CORE_PATH="$PWD/context-folding/python" node --test \
  context-folding/sdks/typescript/test/client.test.mjs \
  context-folding/adapters/pi/adapter.test.mjs
```

部分 TypeScript 测试需要本地回环 HTTP 服务，桥接测试需要启动本地 Python 子进程。受限环境曾使监听或子进程通信失败；上述最终结果来自允许这些本地操作的完整运行。没有执行真实 Magpie/Claude Code 宿主验收、Rust/C# 桥接测试或付费模型调用；没有测量线上延迟或账单收益。

## 仍存在的明确边界

1. **64 MiB 恰好满额时的默认读取。** 默认 `read`/`paste` 需要先持久写入 keep 保护。合法档案恰好占满 64 MiB 时，新增的少量元数据仍可能使操作失败。已实际复现同一原文用 `peek:true` 可以读取。这一轮没有悄悄放宽容量上限或把失败保护报告为成功；README 已更正“始终可读”的过强承诺。
2. **`idleSeconds=0` 的分组回收。** 分组与 `put` 的根集行为不同；未加入 roots 的新组在这个极端设置下可能刚返回就进入回收站。宿主应同步保留集合或 pin 所需组，并使用合适的闲置期限。本轮修复复用时间与回收标记，没有重定义根集合同。
3. **显式包装器声明仍依赖宿主核实。** `recoveryToolName` 表示调用方已经核实隐藏在外层工具中的恢复入口。仅凭一份原生请求无法证明外部包装器实际安装成功；本轮只让可观察的全局禁用优先生效。

## 协议依据

- [OpenAI Function calling：tool_choice 和 allowed_tools](https://developers.openai.com/api/docs/guides/function-calling)
- [OpenAI Chat Completions 请求定义](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- [Anthropic 工具定义与 tool_choice](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools)
- [Gemini FunctionCallingConfig](https://ai.google.dev/api/caching#FunctionCallingConfig)
