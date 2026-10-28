# 0.5.0：由注释决定折叠

旧版的候选筛选、三档策略、摘要脚本与成本批准不再控制请求折叠。当前规则见 [注释主动折叠协议](annotation-protocol.md)。

Agent 在普通文本或源代码注释中写出配对的 `@context-fold begin LABEL` 和 `@context-fold end LABEL`；宿主经过配置的请求延迟，先保存正文，再投影为 `[[cf:v2:<hash>]]`。没有标记就不折叠。何时整理上下文由 Agent 判断。

## 配置迁移

从旧配置中删除以下项目：

- `[folding]` 下的 `mode`、`threshold_tokens`、`keep_recent_messages`、`head_chars`、`minimum_saving_usd`。
- 整个 `[policy]`，包括自动角色、摘要脚本、成本边界与证书脚本。
- `[magpie.accounting]`。
- 早期 0.4.0 的 `[folding].context_window_tokens`、`reserve_output_tokens` 和 `budget_hints`。
- 插件 options 中对应的 camelCase 字段。

保留启用开关、归档容量和恢复入口。延迟由 `[folding].delay_requests` 配置，默认 1。模型窗口大小和上下文预算不属于项目职责，不再配置或注入。系统指导在有归档引用时附上实际 CLI、scope 和归档路径，供 Agent 按需查看原文。`min_savings_tokens` 只防止标记替换造成请求净增，不管理模型容量或选择未标记内容。

旧字段应返回清楚的迁移错误，不能悄悄转换成某个新策略。旧数据库继续保留恢复材料；升级配置不需要删除归档。

## 费用证据

请求缩短仍不等于真实费用减少。模型定价、前缀缓存、恢复读取和 Agent 整理内容的开销都会影响最终账单。0.5.0 不做成本批准，也不假定一个字符或字节对应固定的实际计费 token。

[旧费用分析](economics.md)、[旧基准](benchmark.md)和[旧格式比较](folding-efficiency.md)仅保留为历史证据，不代表当前注释协议已经测得相同收益。
