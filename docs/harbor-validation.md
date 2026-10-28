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

## 完整基准的边界

当前工作环境没有 Docker/Podman daemon，也未配置模型端点和密钥。因此本地没有产生完整 Harbor 容器 trial 或真实模型 A/B 成绩。组件夹具使用临时目录，不是隔离容器；测试通过不能改写成模型成功率、推理提速或账单节省。

新增 GitHub Actions 工作流会运行真实 Docker Harbor smoke：2 个任务 × oracle/nop/脚本 baseline/脚本 folding，共 8 个 trial。每个 trial 的结果及独立评分日志保存在工作流 artifact。工作流是否通过，应以该提交的实际运行记录为准；不能仅凭工作流文件存在宣称已运行。

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
