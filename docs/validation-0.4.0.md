> **历史验收记录（文件归档与任意范围改动之前）。** 本文的 MCP、恢复工具、消息边界及测试计数只对应当时提交，不代表当前文件恢复实现已经完成真实宿主或容器验收。当前接口见 [折叠协议](annotation-protocol.md)；本次新增测试结果另行记录。

# 0.4.0 注释主动折叠验收记录

验证日期：2026-10-28。此记录对应本次源码重构，不表示 npm 已发布，也不继承旧三档策略的性能或账单结论。

## 本次行为

Agent 在普通文本或源码注释中输出成对的 `@context-fold begin/end LABEL`。宿主保存正文，默认等待一次不同的历史请求，然后以正文 SHA-256 的短引用替换视图。预算只报告估算使用量和容量，不触发选材。旧 `mark`、三档模式、被动重复检测、自动摘要和成本审批路径已移除；旧归档仍可恢复。

本轮特别覆盖：跨 Assistant 消息闭合、工具结构保留、图片用户消息截断、原始与投影请求重试、同一消息中多个区段的稳定身份、新 Read 的独立等待期、已闭合区段不受后来损坏区段影响、源码字符串中的伪标记、哈希前缀冲突、归档失败回退、并发恢复保护以及预算提示不累积。

## 已执行

| 检查 | 结果 |
| --- | --- |
| 根 TypeScript 类型检查 | 通过 |
| 根 TypeScript 构建 | 通过 |
| Bun 插件测试 | **171 通过，0 失败**，20 个测试文件 |
| Python 核心测试 | **123 通过，0 失败，0 跳过**，包含可选 JS/TS 解析依赖 |
| Pi 适配器测试 | **6 通过，0 失败，1 跳过**；跳过真实 Pi 宿主 Read 用例 |
| TypeScript SDK 编译 | 通过 |
| TypeScript SDK 测试 | **6 通过，0 失败，0 跳过**；实际 Python 核心集成用例已执行 |
| Magpie 宿主脚本静态检查 | Python 编译、帮助参数、缺依赖时明确退出均通过 |
| npm 打包预检 | 通过；包含新协议模块，不包含已移除的模式、策略及成本模块；未发布 |
| 补丁空白检查 | `git diff --check` 通过 |

环境：Bun 1.4.4、Node.js 24.22.1、Python 3.12.14。可选 Python 依赖安装在隔离目录，通过 `PYTHONPATH` 提供。

可在安装相应依赖后从仓库根目录复现：

```sh
npm ci
npm run check

# 先安装 context-folding 的 Python 依赖及 JS/TS 可选解析依赖。
# 若依赖在隔离目录，把该目录追加到 PYTHONPATH。
PYTHONPATH=context-folding/python python -m unittest discover -s context-folding/tests
PYTHONPATH=context-folding/python node context-folding/adapters/pi/adapter.test.mjs

node node_modules/typescript/bin/tsc -p context-folding/sdks/typescript/tsconfig.json
CONTEXT_FOLDING_REAL_CORE_PATH="$PWD/context-folding/python" \
  node context-folding/sdks/typescript/test/client.test.mjs

python -m py_compile scripts/host-smoke.py
python scripts/host-smoke.py --help
git diff --check
```

Node 的测试启动器在本次环境中只显示文件级计数，因此直接执行两个 `.test.mjs` 文件核对实际子项与跳过数量。TypeScript SDK 的实际核心用例验证首轮和重试保留、下一周期折叠、新 occurrence 独立等待、v2 精确恢复、读回保护、旧引用兼容，以及拒绝已删除的 `mark` 后连接仍可继续使用。

## 尚未实跑

| 检查 | 原因和实际边界 |
| --- | --- |
| 真实 Magpie 宿主端到端测试 | 环境缺少 `magpie` 可执行文件。已更新真实宿主脚本，未用 helper 或模拟宿主替代。 |
| 真实 Pi 宿主 Read | 未配置已安装 Pi 的 `PI_PACKAGE_ROOT`；该用例明确跳过。 |
| Rust SDK | 缺少 `cargo`，只完成接口与示例迁移。 |
| C# SDK | 缺少 `dotnet`，只完成接口与示例迁移。 |
| 真实模型任务质量、默认 compaction、计费节省 | 本轮没有进行对应实验，单元测试不能证明这些结果。 |

单次 PostToolUse 适配器无法自行重写未来历史：默认延迟为 1 且宿主未提供出现身份、请求进展和重投影能力时，保留原文。完整的跨请求延迟由能观察和投影历史的 Magpie 请求钩子实现。

根网关的源码过滤是保守词法扫描，独立 Python 核心使用 Python tokenizer 和可选 JS/TS Tree-sitter。复杂或不确定的网关源码保留原样；其他语言的多行字符串仍有字面标记误识别限制，详见[注释协议](annotation-protocol.md)。

## ctxf 管道与 MCP 追加验证

同日追加独立 Python 命令 `ctxf` 与共享 `fold` action。此次未修改根 Magpie 插件实现；上表的根 TypeScript/Bun 结果来自首次重构验证。Python 与 SDK 的最新计数如下：

| 检查 | 结果 |
| --- | --- |
| Python 完整套件 | **142 通过，0 失败，0 跳过**；新增 19 项 fold/ctxf 测试 |
| TypeScript SDK | 编译通过，**7 通过，0 失败，0 跳过**，包含实际核心 fold |
| Pi 适配器 | **6 通过，0 失败，1 项真实宿主测试跳过** |
| 安装后的 ctxf | 在隔离 Python 环境实际安装成功，8 组命令和协议验收通过 |

安装使用 `uv pip install --python /tmp/ctxf-smoke-venv/bin/python --no-deps --editable ./context-folding`，随后直接运行安装生成的 `ctxf` console script。验证了真实 `ctxf | ctxf` 子进程串管、UTF-8/CRLF/无末尾换行、超过 24,000 字符的跨进程完整恢复、原文读取后的显式再次折叠、无标记与空输入、已有引用旁的新区段，以及无效 UTF-8 和存档失败时 stdout 为空。

实际 MCP stdio 验收完成 initialize、tools/list、fold、read，再由另一个 CLI 进程从同一归档和 scope 恢复全文；RPC fold 返回相同投影。这证明独立服务与 CLI 的接线，不能替代前述真实 Magpie/Pi 宿主验收。

独立复核发现并修复了 call 的 scope 覆盖、短输出遇到关闭管道时退出阶段再次 flush，以及后续 roots 替换后的引用保活边界。定向复跑全部通过。测试还使用真实 SQLite 触发器模拟提交失败，确认不会输出未成功存档的引用。空输入、无标记及无法缩短的文本不写入 scope，也不会因新写入配额失败。

Rust/C# 的 fold 薄包装和示例已同步，仍未获得相应工具链执行结果。
