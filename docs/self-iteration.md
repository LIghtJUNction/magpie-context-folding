# 本项目的沙箱测试与模型迭代

被测对象是这个仓库的实际源码和测试。离线测试入口将当前工作树（包括未提交修改）复制到一次性目录，用 Linux bubblewrap 隐藏宿主项目和主目录，单独创建网络命名空间，只读挂载必要运行时和已安装依赖。模型请求由沙箱外的控制器发送，模型生成的命令只能在沙箱中执行；凭据不进入工具进程。

## 离线基准

需要 Linux、bubblewrap、Bun、Node/npm，以及本地已安装的根 npm 依赖和与运行 Python 版本匹配的独立核心 JS/TS 解析器依赖。入口不安装或下载依赖。

```sh
npm run bench:self -- --output /tmp/magpie-self-result.json
```

入口依次验证隔离边界，记录运行时版本，运行 `npm run check`、单独的 TypeScript 递归套件和 Python 核心全套测试。任何检查失败或沙箱不可用都会退出非零。JSON 保存快照摘要、Git 版本与脏文件摘要、实际命令、返回码、耗时及完整输出。测试文件列表表示执行范围，不代表测量了分支覆盖率。

## Luna 编码试验

模型显式默认为 `codex/gpt-6-luna`，接口使用仓库已有的 Chat Completions 协议。设置 `HARBOR_MODEL_BASE_URL`、`HARBOR_MODEL_API_KEY`；本机 Magpie 环境也可使用已有的 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_AUTH_TOKEN` 连接同一网关。后者只是网关认证来源，不会把模型切换为 Claude。远程端点需要 HTTPS；HTTP 仅允许 loopback。真实推理会消耗所配置服务的模型额度。

先给定一个范围明确、可独立验证的任务。例如检查本仓库归档相关代码：

```sh
npm run bench:iterate -- \
  --model codex/gpt-6-luna \
  --output .local-tests/luna-archive-example \
  --allowed-path src/store.ts \
  --allowed-path test/store.test.ts \
  --verify 'bun test --isolate test/store.test.ts test/tree.test.ts' \
  --task 'Inspect archive graph validation for a reproducible defect. Make a minimal fix in src/store.ts with a regression in test/store.test.ts; preserve existing behavior and run the full selected suites.'
```

每次命令先冻结一次当前源码和宿主侧 bridge，再从该冻结版本为每个模式创建独立副本：baseline 保留完整历史，folding 使用真实 `benchmarks/harbor/bridge.ts` 和生产请求钩子。两者使用相同模型、任务、基础提示、工具与验证命令。运行时与依赖只读复用本机安装，不复制冻结；一次试验期间不要升级它们。模型自己决定是否标记过程内容，未产生折叠也是有效结果。归档查询通过真实 CLI，仅能访问该 trial 的 scope。

模型可以在单次 trial 中反复执行“检查 → 修改 → 测试 → 再修改”。默认最多 24 次请求，每次输出上限 4096 token；这些是运行边界，不是成功条件。`--max-turns` 可调整。`--modes folding` 可单独检验一个候选，`--iterations` 只重复独立尝试，不自动累计修改。需要 Harbor 组件时加 `--harbor`，让沙箱只读访问本地已有的 Harbor Python 依赖。

每次试验先在模型工作副本运行初始验证；模型结束后，从冻结源码新建干净验收副本，只导入允许的候选文件修改，再运行后验与可选 `--acceptance` 命令。模型缓存和范围外文件不会进入验收副本。完整初验消息是默认行为。可选 `--verification-output summary` 在通过时只披露摘要，完整内容保存在沙箱 `.benchmark-verification.json`，模型可按需读取；失败日志完整提供。两种模式均保存同一日志文件。摘要模式仍需按任务验证质量后采用。

`--exclude-path` 可从模型与验收源码副本中排除评分答案等精确文件路径，这些路径不能作为候选导出。`--candidate-feedback` 与 `--acceptance` 配合时，模型至多两次调用 `check_candidate`，在干净副本查看当前交付的验收反馈；检查器作者应确保 stdout 不含标准答案，stderr 不返回模型。成本、速度与六题仓库合同质量对照见[本轮说明](cost-speed-quality.md)。

每次试验保存：

- `transcript.jsonl`：真实模型回复、工具结果和 API usage。
- `result.json`：请求模型和服务端返回模型、每次输入字节与投影字节、折叠及查询次数、退出原因、独立验证和变更文件。
- `candidate/`：仅导出 `--allowed-path` 允许的候选文件。默认不导出；范围外变更会使试验不能标记为 verified。
- `folding-state/`：该 trial 的私有归档和 bridge 日志。

模型正常结束、独立验证成功且没有范围外变更，试验才标记为 `verified`。控制器不会直接把候选覆盖到真实工作区，也不会提交、推送或触发 CI。维护者或上层代理需要审阅候选差异，再合入本机并重跑完整检查；下一轮由更新后的项目重新创建沙箱，这样每轮都测试实际候选版本。

验证命令是显式提供的验收入口，不能仅凭模型声称“通过”判定成功；模型可以修改的测试也需要独立审阅。字节差不是供应商 token 节省，缺失 usage 不当作零费用，小样本不产生稳定提速或账单节省结论。脚本和 fixtures 不计为真实模型能力成绩。

## 2026-10-28 实际迭代

两名辅助代理完成缺陷复现、修复和独立检查；真实模型试验使用 `codex/gpt-6-luna`，服务端报告 `gpt-6-luna`。累计 10 个 trial、127 次试验请求，完整失败分母和 API usage 见 [self-iteration-results.json](self-iteration-results.json)。早期试验存在请求上限、沙箱挂载和工具参数不兼容失败，均未当作成功。

最终 CLI 复验正常结束，29 项检查通过；十二层递归基准的 baseline/folding 使用相同源码摘要，各自新增回归测试并通过 169 项 Python 测试。两组分别用了 11 次和 5 次请求，但两组对话都没有实际折叠，因此这不是折叠节省用量的证据。审阅后合入 folding 组的十二层测试，并补强有界读取和列表分页断言。

实际修复包括：50,000 层归档引用链校验栈溢出；首次归档遗漏来源范围导致重放增长并影响配额；CLI 精简后的兼容入口缺失；Harbor terminal、专用归档查询与真实 bridge 的接线。原有默认完整读取和 JSON 列表行为保留。

最终离线沙箱验收：根项目 253 项通过，单独 TypeScript 递归套件 72 项通过（这些是全套的子集，不叠加计数），Python 核心 169 项通过，控制器回归 7 项通过。另有 Harbor 组件 34 项通过、Docker smoke 8 个正负控制符合预期、真实 Magpie/Bun 宿主 18 次合成请求通过。没有触发远程 CI 或模型迁移；API 未提供实际账单，费用保持未知。

## 控制器回归

```sh
npm run test:controller
```

这套检查不调用模型，覆盖候选文件导出、输入校验及失败落盘等控制边界。原始试验产物放在已忽略的 `.local-tests/` 或指定的本机输出目录；长期保留的结果应整理为不含凭据的摘要，避免提交完整模型轨迹或私有归档。
