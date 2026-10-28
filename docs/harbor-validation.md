# Harbor 接入验证记录

日期：2026-10-28（Asia/Taipei）。接入基于主动注释折叠分支 `feat/agent-authored-folding-20261028`，基线提交 `2223739d41518fd35b6d43f8c9baedf184df1d44`；未把尚未合并的 0.4.0 重构换回旧 main。

## 本地实际完成

| 检查 | 结果 |
| --- | --- |
| `npm run check`：TypeScript 类型检查、Bun 插件回归、构建 | 通过；175 测试通过，0 失败，其中 4 个为新增 bridge 测试。 |
| Harbor Python 组件检查 | 31 测试通过，0 失败；真实 Harbor 类与真实生产钩子，模型 HTTP 使用明确的夹具。 |
| 固定 Harbor 0.25.0 的 Task / Job / Agent 参数校验 | 通过；实际任务 schema 1.4，两个任务和四个 smoke Agent 配置可加载。 |
| 独立评分器正向控制 | 两个 oracle 通过全部 35 个功能检查。 |
| 独立评分器负向控制 | 未完成脚本、公开样例硬编码、崩溃提交均被拒绝。 |
| 真实生产钩子 + 脚本循环 | 两个任务 × baseline/folding 完成组件验证；延迟、恢复、原始 transcript 保留和源码读取投影被实际执行。 |
| HTTP、计量与清理 | 无自动重试、不跟随重定向、失败请求令未知用量保持未知；取消、启动失败、指标落盘失败均清理子进程。 |

本地运行环境：Python 3.12.14、Bun 1.4.0、Node 24.22.1、Harbor 0.25.0。原始命令和结果摘要见 [harbor-local-validation.json](harbor-local-validation.json)。

## 实际 Harbor Docker smoke：通过

2026-10-28 09:10（Asia/Taipei），[GitHub Actions 运行 40612866824](https://github.com/LIghtJUNction/magpie-context-folding/actions/runs/40612866824) 完成并通过。实测代码为 PR head `b601b26a190ee6130e75cf0ded58792446ce3293`；Actions 检出其测试合并提交 `e4c14849f23ea11486c654d54c15a51f8b3abe7b`。下表来自已下载、校验 SHA-256 并逐项读取的实际 trial result.json。

| 任务 | oracle | nop 负向控制 | 脚本 baseline | 脚本 folding |
| --- | ---: | ---: | ---: | ---: |
| config-precedence | 1 | 0 | 1 | 1 |
| ledger-reconciliation | 1 | 0 | 1 | 1 |

8 个 trial 全部符合预期，执行异常 0；verifier 均使用独立容器。两个 folding trial 各完成 5 轮脚本请求，其中 1 轮请求实际包含折叠引用，并完成 1 次精确恢复；两个 baseline trial 均为 0 次折叠、0 次恢复。每个 trial 的 token 和费用都保持 null，因为没有模型推理。

报告模块也已读取这批真实 Harbor 结果，正确保留 8 个样本及 nop 的 0 分，并将所有模型效率比较标为不可用。没有把 Harbor 控制台自动生成的脚本 Pass@2 当作模型能力分数。

长期摘要：[harbor-ci-validation.json](harbor-ci-validation.json)。完整 [CI artifact](https://github.com/LIghtJUNction/magpie-context-folding/actions/runs/40612866824/artifacts/12783801662) 的 SHA-256 为 `99816b255d427b3704eb9190fb55286ae6fa32c4008d03d30e9c683a2cbaebf7`；该临时下载产物按工作流设置保留 7 天，摘要随源码保留。

## 真实模型基准的边界

当前工作环境没有 Docker/Podman daemon，也未配置模型端点和密钥。因此本地没有产生完整 Harbor 容器 trial 或真实模型 A/B 成绩。组件夹具使用临时目录，不是隔离容器；测试通过不能改写成模型成功率、推理提速或账单节省。

本机缺少 Docker 的限制已通过上述 GitHub Actions 容器 smoke 补充验证。CI 没有配置或调用模型服务，真实模型 A/B 仍未执行。

`ScriptedSmokeAgent` 有意读取已知 oracle，只检查任务、生产钩子和恢复接线；它的 reward 不是模型能力得分。真实模型基准需要显式提供端点与模型，使用 `npm run bench:harbor -- run --model ...`。默认模型名、凭据和单价均未写死。

## 复现入口

```sh
npm ci
uv sync --project benchmarks/harbor --frozen --python 3.12
npm run check
npm run test:harbor
npm run bench:harbor -- validate
npm run bench:harbor -- doctor
npm run bench:harbor -- smoke
```

运行说明、数据集入口和指标解释见 [Harbor README](../benchmarks/harbor/README.md)。普通字节统计、API token、任务正确率和实际费用分别记录，未知字段保持 `null`。缺失试验、执行错误、不同任务版本/代码/端点及不完整用量会阻止效率结论，原始失败仍保留。
