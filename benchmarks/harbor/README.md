# Harbor 基准接入

**本质上是把同一道题交给同一个 Agent 跑两遍：一遍发送完整历史，一遍在发请求前调用项目现有折叠钩子，最后用独立测试判题。**

本目录基于 0.5.0 的主动注释与 CLI 恢复协议。它固定 `harbor==0.25.0`，完整 Python 依赖记录在 `uv.lock`；实际任务格式为该发布包的 `schema_version = "1.4"`。生产 npm 包不依赖 Harbor。Harbor 的[自定义 Agent 接口](https://docs.harborframework.com/agents/custom-agents)、[任务格式](https://docs.harborframework.com/tasks/overview)和[结果格式](https://docs.harborframework.com/jobs/configs)可查官方文档；移动中的在线文档与固定发布包不同，以本目录已校验的包接口为准。

## 测的是什么

| 组成 | 实际工作 |
| --- | --- |
| Harbor | 建立任务容器，执行一个 trial，收集产物，在另一容器运行评分器。 |
| `magpie_harbor.agent:MagpieAgent` | 一个简单的 Chat Completions 工具循环；`terminal` 和完整 `read_file` 在容器执行，`context_folding` 通过真实 CLI 查询当前 trial 的归档。旧终端调用别名保持兼容。 |
| `bridge.ts` | 调用实际 `src/context.hooks.ts` 的 `onRequest/onResponse`，恢复由真实 CLI 子进程完成。没有另写压缩算法。 |
| baseline | 完整历史，使用同一基础任务提示和工具声明；归档查询返回不可用，不创建折叠归档。 |
| folding | 同一基础提示、工具与模型参数；实际钩子自动注入短规则，并把真实可调用的 `terminal` 声明配置为 shell 入口，默认延迟一个请求。指导和 CLI 回查开销全部计入请求，不注入上下文预算。 |

Agent 始终保留原始 transcript。每轮只将发送给模型的副本交给 bridge。普通 Assistant 标记和明确识别的源码完整读取可折叠；普通 shell 输出不伪装成源码读取。模型必须自己决定写哪些注释，没有额外总结模型，也没有自动挑选历史。

这是**真实插件钩子 + 一个基准用 Agent**的集成。它不启动 Magpie 网关进程，不代表 Claude Code、Codex CLI 或 Magpie 宿主完整端到端行为。仅支持显式完整历史的 Chat Completions 文本和 function tools；不声明支持 Responses、供应商隐藏历史、多模态或跨任务会话恢复。外部数据集如果要求这些能力，需要另写对应适配器。

## 安装与检查

在仓库根目录执行。需要 Python >= 3.12、Bun >= 1.4.0、Node >= 22、uv，以及运行中的 Docker daemon。

```sh
npm ci
uv sync --project benchmarks/harbor --frozen --python 3.12
npm run bench:harbor -- doctor
npm run bench:harbor -- validate
npm run test:harbor
```

若要让模型直接修改和测试本仓库，而非求解下方合成任务，使用独立的[项目自身沙箱迭代入口](../../docs/self-iteration.md)。

`doctor` 只报告能力和是否配置凭据，不输出凭据。Bun 不在 PATH 时可将 `HARBOR_BUN` 指向其绝对路径。没有 Docker 时仍能做配置、真实钩子和评分器组件检查；这些检查不算完成 Harbor 容器基准。

## 先跑不调用模型的 smoke

```sh
npm run bench:harbor -- smoke
```

对两个内置任务各执行四个控制，共 **8 个 Harbor trial**：

| 控制 | 期望 |
| --- | --- |
| `oracle` | 参考实现通过，reward = 1。 |
| `nop` | 不做任务，应失败，reward = 0；这是评分器的负向控制。 |
| `ScriptedSmokeAgent` + baseline | 确定性脚本通过，历史不折叠。 |
| `ScriptedSmokeAgent` + folding | 确定性脚本通过，真实延迟折叠、精确 CLI 查阅，查看后历史继续保持折叠。 |

归档查询由 `context_folding` 或终端中识别出的固定 CLI 命令，通过相同的真实 CLI 子进程执行 `read`、`list`、`grep`、`meta`、`status`，只允许当前 trial 的 scope 与归档目录。嵌套查询返回当前节点的视图，子节点保持短引用；按需继续读取子节点，不展开原历史。

脚本 Agent 直接使用仓库中公开的 oracle，并不测模型解题能力。它不会连接模型服务，token/费用保持未知，不伪造为零。命令会检查所有预期 trial 的实际结果，不能只因 Harbor 进程退出码为 0 就判通过。

两个任务是小型合成接线题，**不是已发表的能力排行榜**：`ledger-reconciliation` 验证账本去重与整数分计算，15 个独立断言；`config-precedence` 验证配置递归覆盖、删除及边界条件，20 个断言。评分器在独立容器中运行，仅接收提交脚本和输出目录；原始题目数据、隐藏测试不随 Agent 文件系统转移。任务内禁用网络，Agent 使用 UID 10001。Docker 镜像固定为 `python:3.12.12-slim-bookworm` 标签，Harbor 日志保留构建信息；标签仍可重新发布，严格复现实验时应再固定审核过的镜像 digest。

GitHub Actions 工作流 `.github/workflows/harbor-benchmark.yml` 在相关 PR 与手工触发时运行上述检查，不读取模型 secrets、不发起模型推理。

## 运行真实模型 A/B

明确选择自己有权限使用的 Chat Completions 端点及模型。下列值是占位符，不会自动选模型或注册计费服务。`HARBOR_MODEL_BASE_URL` 是 API 基础 URL（通常以 `/v1` 结尾），程序追加 `/chat/completions`；`--model` 必须是该端点实际接受的完整 model ID，不会自动拆掉 `provider/` 前缀。

```sh
export HARBOR_MODEL_BASE_URL='https://YOUR-ENDPOINT/v1'
export HARBOR_MODEL_API_KEY='YOUR-KEY'

npm run bench:harbor -- run \
  --model 'YOUR-MODEL-ID' \
  --attempts 3
```

密钥只从父进程环境读取，不进入 job 配置、bridge 子进程或任务容器。远程端点必须使用 HTTPS；本地无密钥服务支持 loopback HTTP。工具调用必须由端点支持。请求失败不自动重试，避免把重复推理隐藏在总量之外。

部分模型要求 `max_completion_tokens`，可加 `--output-token-field max_completion_tokens`。默认不发送 temperature 或 seed；只有端点支持时显式添加 `--temperature` / `--seed`。这些参数会记录在 Harbor 配置里；seed 不保证供应商结果完全确定。

默认每种模式对每道题做 3 次尝试，共 12 个 trial，并发为 1、自动重试为 0。默认最多 32 轮，每轮输出上限 4096 token，命令执行最长 60 秒，模型 HTTP 请求最长 120 秒；内置 task 的 Agent 总超时为 180 秒。需要更长任务时调整相应 task.toml 或 Agent 配置，不通过默默截断模型历史完成请求。

先检查将要运行的配置：

```sh
npm run bench:harbor -- run --model 'YOUR-MODEL-ID' --config-only
```

生成的 `jobs/*.config.json` 可直接用 `harbor run -c` 运行，前提是 `PYTHONPATH` 包含本目录。`run.py` 会自动设置此路径。

可使用同一个适配器运行已发布的 Harbor 数据集，例如指定明确版本：

```sh
npm run bench:harbor -- run \
  --model 'YOUR-MODEL-ID' \
  --dataset terminal-bench@2.0 \
  --attempts 3
```

也可用 `--task-path /absolute/path/to/task` 运行一个本地任务。外部数据集遵从它自己的环境、资源与网络配置；内置 smoke 的隔离设置不自动应用于外部任务。执行公开大数据集会产生相应的计算与模型调用开销，应先用小任务确认端点兼容。

## 读结果

```sh
npm run bench:harbor -- report \
  benchmarks/harbor/jobs/ACTUAL-JOB-NAME \
  --output benchmarks/harbor/results/report.json
```

真实模型运行结束时也会自动生成 `JOB/magpie-summary.json`。Harbor 保存每个 trial 的 `result.json`，adapter 另外保存 `agent/transcript.jsonl`、`folding-metrics.json`、bridge 日志及隔离归档。恢复引用对应的原文留在该 trial 的归档中；不要把一个 trial 的状态目录复用给另一个。

报告分别记录：

- 任务正确率与每次 reward；失败、无评分和执行错误保留在全部已观察尝试的分母中。
- API 明确报告的 input / output / cached tokens；输入已经包含缓存输入，不能再加一次。
- 请求发送前后的 JSON UTF-8 字节、钩子处理耗时、恢复调用次数与 Agent 用时。
- 模型身份、端点哈希、源码提交、实际代码内容哈希、任务校验和、运行参数和结果完整性。

没有提供的 usage 保持 `null`。一次已发送请求报错后，可能计费但无法取得 usage，该 trial 的总用量也变为未知。费用保持 `null`，不按字符或公开单价猜账单。原文 JSON 字节和投影字节是同一条已发生轨迹上的比较；它们不是“如果关闭折叠模型会怎样”的反事实 token 数。

只有匹配模型、端点、代码、任务与参数，结果完整、样本数相等、所有尝试成功且 usage 完整时，报告才给描述性的均值差。小样本、缓存波动、调度和模型随机性仍可能影响差值；报告不生成显著性结论或省钱保证。脚本 smoke 永远不会进入真实模型效率比较。模型没有输出标记时可能完全不折叠，这也是应保留的真实结果。

## 验证范围

组件测试调用真实 Harbor schema、实际 Bun hook 和独立评分器，覆盖延迟、重试、恢复、scope 隔离、缺失 usage、HTTP 失败、取消清理及失败分母。它们明确使用假模型和本地环境替身，不冒充容器运行。0.4.0 的历史容器执行结果见[历史验证回执](../../docs/harbor-validation.md)；本轮 CLI-only 改动的验证范围见[0.5.0 记录](../../docs/validation-0.5.0.md)。
