# 0.5.0：系统指导、CLI 恢复与开销验证

> 历史验收记录：本页对应 PR #11 在预算移除、客户端显示与嵌套查询整合前的实现。文中的可选预算、默认读取长度和测试数量仅对应当时快照；当前配置和查询行为以 [README](../README.md) 为准。

日期：2026-10-28（Asia/Taipei）。基线为 `8fd0bf70dc2729b3662e3112c522698af0b2847f`。这是本轮源码改动的验证记录，不是已部署用户会话或真实模型 A/B 的声明。

## 改了什么

- Magpie 请求钩子自动注入一条系统指导；Chat 使用已有的 system/developer 角色，其他协议使用各自系统字段。原宿主指令前缀保留，重复注入、宿主合并与 CRLF 规范化不会累积副本。
- 根插件不再注册模型工具；Python 独立 MCP 服务、stdio 子命令和工具 schema 均已移除。现有终端工具执行 CLI，SDK 保留本地 JSON Lines RPC。
- 预算提示默认关闭。候选来自显式标记，完整发送请求净减少默认至少 256 个估算 token，计算包括系统指导、CLI 路径、归档目录、scope、引用及可选预算。
- CLI 默认有界查看约 4,000 个 UTF-16 单元，保持归档折叠；`--all` 读完，`--restore` 才持久展开。显式 `--state-dir` 保证不同进程环境读取同一归档。
- 继续保留原文先提交、失败返回原输入、会话隔离、工具协议配对和签名内容保护。

## 实际请求对比

完整机器记录见 [cli-overhead-results.json](cli-overhead-results.json)。测试执行了真实基线与当前源码，基线通过 Git 导出到临时目录，使用真实 `ContextFoldingPlugin()` 的工具声明。两版使用完全相同的原始历史与已有 `exec_command` 工具。没有调用外部模型，也没有为旧版加上 README 建议手工粘贴的教学文本。

估算口径是 `ceil(JSON.stringify(完整请求) 的 UTF-8 字节数 / 4)`，并不是模型 tokenizer 计数。下表设置 `delayRequests=0`，用于隔离请求变换的成本；默认等待机制另测。

| 场景 | 版本 | 输入估算 token | 实际发送估算 token | 是否折叠 | Hook 自身净减少 |
| --- | --- | ---: | ---: | --- | ---: |
| 43 字符演示笔记 | 旧版 | 1,401 | 1,433 | 是 | -32 |
| 43 字符演示笔记 | 新版 | 203 | 277 | 否 | -74 |
| 24,599 字符长过程 | 旧版 | 7,571 | 1,433 | 是 | 6,138 |
| 24,599 字符长过程 | 新版 | 6,373 | 348 | 是 | 6,025 |

旧插件工具声明增加 4,791 字节，约 1,198 个估算 token。去掉该声明后，短笔记的发送请求比旧版少 1,156 个估算 token，长过程少 1,085 个。长正文的替换缩减量两版相同，跨版本改善主要来自移除工具 schema，不能解释成正文压缩算法提高。

新版无折叠时仍增加 297 字节，约 74 个估算 token 的固定指导。长例子加入实际 CLI 路径和 scope 后，指导约 169 个估算 token；表内 6,025 的净减少已扣除此开销。短会话不是零成本，统计保留负值。

真实 CLI 子进程检查：同一长归档，旧版默认读取 24,599 个 UTF-16 单元并设置 keep；新版默认读取精确前缀 4,000 个单元，折叠状态保留，下一页位置在 stderr。此处主动读取是测试操作，不是模型日常流程。恢复工具调用本身的模型输入/输出成本没有计入上述单次 hook 表。

默认 `delayRequests=1` 的独立测试中，两版首轮和完全相同重试均不折叠；下一次不同请求时，旧版折叠短、长两种内容，新版只折叠长内容。

## 执行结果

| 检查 | 结果 |
| --- | --- |
| `npm run check` | TypeScript 类型检查、196 项 Bun 测试及构建全部通过。 |
| 独立 Python 核心 | 141 项全部通过，无跳过；使用声明范围内的 Tree-sitter 可选依赖。 |
| Harbor 组件测试 | 本地 `test_agent.py` 13 项通过；GitHub CI 全部 31 项通过。 |
| 真实 Harbor Docker | 两题 × 四种控制，共 8 个 trial 全部符合预期，执行异常为 0。 |
| 真实 Magpie HTTP 宿主 | Magpie 0.1.1774 + Bun：18 个本地 HTTP 请求通过，响应钩子验证成功 18 次，未知/失败为 0。 |
| Harbor TypeScript bridge | 4 项通过，已包含在 196 项 Bun 测试中。 |
| 系统提示独立复验 | 74 组原文保留、LF/CRLF、合并与重复注入案例通过。 |
| 真实 CLI | 跨进程、不同环境的显式归档定位、短哈希读取、分页、Unicode、查看/恢复差异通过。 |
| `git diff --check` | 通过。 |

Bun 1.4.4 的异步管道在默认执行沙箱中触发 `EPERM`；最小独立例子同样触发。在自动审批允许的正常子进程环境中，完整测试通过。没有为绕过这一环境限制修改产品逻辑。

## GitHub CI 补齐真实宿主验证

本地容器最初因 `bwrap: Creating new namespace failed: Operation not permitted` 无法启动真实宿主测试。随后增加独立 GitHub CI job，使用相同的隔离脚本，已成功启动真实 Magpie 0.1.1774 与 Bun，路由到本地假模型 HTTP 服务。[宿主运行记录](https://github.com/LIghtJUNction/magpie-context-folding/actions/runs/40620173616/job/122592025514) 对应实现代码未变、增加 CI 接线的提交 `9b3f84a02042e99a2b9ffaf5658c488521512b7a`。

官方二进制为 55,136,418 字节，固定 SHA-256：`6290e485744109d9cec8385d947bbb66423adfc4885bc0ca3e6c2a4d020670e9`。测试保留 home 隔离、独立 XDG 状态与账号发现禁用，没有调用外部模型。

实际通过的 18 个 HTTP 请求覆盖：无 MCP 时插件钩子加载、简短系统指导、预算默认关闭、默认等待及重试、原指令与工具结构保留、投影重放、Unicode/CRLF 精确分页恢复、显式 --restore、会话隔离、源码新版本和原文件不变。`onResponse` 统计为 18 次成功、0 次未知、0 次失败。

[Harbor CI 运行](https://github.com/LIghtJUNction/magpie-context-folding/actions/runs/40619609457) 已通过完整组件测试及真实 Docker 控制：两题的 oracle 均为 1，nop 均为 0，baseline/folding 脚本均为 1；8 个 trial 全部符合预期、执行异常为 0。这里的脚本知道参考实现，不代表模型解题能力。

机器回执提取自实际 CI 日志，见 [ci-validation-0.5.0.json](ci-validation-0.5.0.json)。日志归档按工作流保留 7 天，关键结果已随源码保存。

## 剩余边界

未在用户已经安装的桌面会话中替换插件，未调用真实模型做质量、延迟或账单 A/B。这里的数字只证明本组固定请求的序列化开销和恢复行为变化；缓存效果、真实 tokenizer 和模型是否会正确选择长期可折叠内容仍需实际使用验证。

宿主合同依据：[Magpie 插件官方文档](https://usemagpie.ai/docs/plugins#async-gateway-request-hooks)。修改 `model`、`stream`、工具声明或 tool choice 会导致宿主回滚；本实现保留这些字段原样。安装位置不保证 CLI bin 出现在 Agent PATH，所以指导使用实际 Bun/CLI 绝对路径。源码更改需要重载插件。
