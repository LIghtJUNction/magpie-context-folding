# magpie-context-folding 0.5.3 / context-folding 0.1.1

通用过程折叠协议与 Agent 软件无关：`>> 开始缘由 <<` 打开，`<< 结束结果 >>` 关闭。两端文案可不同，折叠时原样保留；只替换中间正文。

## 变化

- Magpie 插件与独立 `ctxf` 核心均识别整行起止标记，支持嵌套，保留原换行和已有源码注释标记。
- 折叠正文显示 `line`、完整 SHA-256 `hash`、估算 `tokens`、`tokens_method:utf8-bytes/4-ceil`、规范绝对路径 `path` 和兼容恢复引用。
- 原文作为普通 UTF-8 文件原子保存到存储目录的 `archive/<完整 SHA-256>.txt`。任何 Agent 或文件工具均可直接读取；文件不依赖会话数据库查询，也不随会话清理自动删除。
- 返回折叠视图前同步文件与目录；已有同名文件校验精确内容，拒绝损坏或符号链接目标，不覆盖异内容文件。
- 未闭合、无净收益区域保留原文；已有元数据不会再次归档。保留 0.5.2 的源码定向投影、指导退避及恢复能力。

## 本地验证

- TypeScript 类型检查、构建通过；322 项 Bun 测试通过。
- Python 项目环境启用可选 JS/TS 解析依赖后，172 项 unittest 通过。
- 隔离真实 Magpie/Bun 宿主：23 项检查，32/32 请求到达本地合成 HTTP 上游；32 次响应 hook 成功，失败与未核实均为 0。
- 新宿主用例验证不同起止文案、CRLF 保留、重复投影和按完整哈希命名的规范绝对路径；直接读取文件恢复精确原文。
- npm 打包清单包含源码及构建后的归档文件模块；Python wheel 与源码包均成功构建。

这些测试没有调用真实模型，不证明回答质量、账单节省或真实 Provider 缓存效果。

## 安装

```sh
magpie plugin add npm:magpie-context-folding@0.5.3
uv tool install https://github.com/LIghtJUNction/magpie-context-folding/releases/download/v0.5.3/context_folding-0.1.1-py3-none-any.whl
```

Python 包通过本 Release 的 wheel 和源码包发布；本次不声明 PyPI 发布。保留已有归档与插件开关，避免重复加载源码和 npm 副本。

## 复现

```sh
npm run typecheck
bun test --isolate --timeout=15000 test/*.test.ts
npm run build
uv run --project context-folding --extra javascript python -m unittest discover -s context-folding/tests
npm run test:host
npm run test:host:installed -- --expected-version 0.5.3
```
