# 0.6.0

在长正文里使用 `>> 起因 <<` / `<< 结果 >>` 请求折叠，用 `→ 不折叠开始` / `← 不折叠结束` 保留其中的关键部分。保留区里的示例标记按字面保留；外层其余正文显示为 `...`，完整原文（包含保留区）保存为 `archive/<SHA-256>.txt`。

技能与插件指导均已加入具体示例，明确不标记空区域、进度播报或仅有工具调用的过程。旧源码注释标记仍兼容。

## CLI 迁移

CLI 现在只管理包含哈希 `.txt` 文件的目录，不读取会话数据库。

```sh
magpie-context-folding stats --dir /实际归档目录
magpie-context-folding list --dir /实际归档目录 --sort size --order desc
magpie-context-folding search '关键字' --dir /实际归档目录
magpie-context-folding read 实际哈希 --dir /实际归档目录
magpie-context-folding clean --older-than 30 --dir /实际归档目录
```

`clean` 默认预览，`--apply` 执行删除。`read` 也可直接用 `cat` 读取元数据中的绝对路径。

旧 CLI 的 `--scope`、`--state-dir`、层级、分页和 `--restore` 等参数以及 `grep`、`meta`、`paste`、`status`、`statusline`、`sessions`、`hook`、`report`、`forget`、`config` 命令不再支持。`--dir` 指向哈希文件目录本身。原有会话数据库和归档不自动删除，读取文件不会改变折叠状态。

新增语法属于 Magpie 插件，独立 Python `ctxf` 保持自己的接口和协议。

## 安装

```sh
magpie plugin add npm:magpie-context-folding@0.6.0
```

先移除同一插件的本地源码注册或旧版本注册，避免重复加载。插件包包含 `.agents/skills/context-folding/SKILL.md`，可将其复制到 Codex 的 `~/.codex/skills/context-folding/SKILL.md`，新开会话调用 `$context-folding`。

## 验证

```sh
npm ci
npm run check
npm run test:host
python3 -I scripts/installed-package-smoke.py --package /实际安装包目录 --expected-version 0.6.0
```

单元测试覆盖四种协议的局部保留、完整原文校验、重复投影、嵌套和目录 CLI。host smoke 使用真实 Magpie/Bun、隔离临时归档和本地合成 HTTP 上游，验证新 CLI、箭头保留区、原文文件与请求重放；不调用外部模型，不证明模型质量或费用收益。发布包验收在独立临时目录复制已安装包后执行同一 host smoke。
