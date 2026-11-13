# magpie-context-folding 0.5.4 / context-folding 0.1.2

## 行为

- 首个短任务及后续每次可恢复请求持续注入一份系统指导，不再等待大上下文或无折叠退避间隔。
- 将长评审、长报告与详细解释纳入明确的标记输出协议。每阶段一对 `>> 具体起因 <<` / `<< 已验证结果 >>`，当前结果、约束、失败与下一步留在外面。
- 短回答、明确要求的 JSON、纯代码与精确答案不加标记。模型不计算 token，不编造 hash、path 等元数据；真正折叠仍经过归档和完整请求净收益检查。
- scoped CLI 仍只在新折叠或相关问题中出现；通用规则持续存在，固定开销如实记录。
- 独立 Python 的压缩后提醒也改用通用箭头标记。原文文件和已有归档保持兼容。

## 验证

TypeScript 类型检查、构建和 322 项测试通过。Python 压缩后提醒相关 6 项测试通过。隔离 Magpie/Bun 宿主 32 次请求全部通过，连续六轮都只有一份规则，响应失败与未核实为 0。

真实 Cursor/Grok 单任务试验：用户仅给出 693 B 的网关配置审查任务，没有提折叠、压缩或标记。最初较软的“支撑细节”指导未能让模型标记 8,956 B 的评审；改成明确要求长评审使用协议后，模型主动生成一对闭合标记，9,555 B 的回复经下一轮插件投影后为 1,121 B，归档正文与模型原文逐字节一致。另一个“只输出 OK”请求仍精确返回 `OK`。

测试调用候选插件真实的 `onRequest` 生成系统注入，然后通过现有网关调用真实模型；转发时移除 shell 工具，使旧安装版 hook 保留候选规则，避免它用旧指导覆盖测试规则。下一轮折叠与原文校验也通过候选 hook 完成。[原始回执](benchmarks/proactive-guidance-live-0.5.4.json)包含任务、指导哈希、标记和两次尝试结果。这是一个任务样本，不是所有模型的遵循率或账单节省证明。

## 安装

```sh
magpie plugin add npm:magpie-context-folding@0.5.4
uv tool install --force https://github.com/LIghtJUNction/magpie-context-folding/releases/download/v0.5.4/context_folding-0.1.2-py3-none-any.whl
```

## 复现本地合同

```sh
npm run check
uv run --project context-folding --extra javascript python -m unittest discover -s context-folding/tests -p 'test_post_compaction*.py'
npm run test:host
npm run test:host:installed -- --expected-version 0.5.4
```

按原始回执的 task 发送不包含标记要求的普通用户问题，系统规则由当前插件注入；检查模型输出的标记，再将输出放入下一轮历史，确认正文归档与元数据投影。真实模型结果存在变动，应保留失败样本，不把提示词文本校验当成模型已遵循。
