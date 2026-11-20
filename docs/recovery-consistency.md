# 归档读取与并发一致性

本页描述 Magpie 插件及 `magpie-context-folding` CLI。独立 Python `ctxf` 使用自己的存储与接口，见其[传输合同](../context-folding/docs/TRANSPORT.md)，不能混用引用或参数。

## 先保存，再发布引用

请求钩子只有在原文文件和数据库状态提交成功后才返回折叠视图。数据库不可写、配额不足、原文损坏或状态冲突时保留原请求。有效标记闭合后直接折叠，不设置长度、token 或净收益门槛。

事务核对 revision 与原始 snapshot，并在 SQLite 写锁内完成容量检查、原文文件发布和数据库提交。提交失败时清理本次新建的文件，保留此前已有的归档。已存在的原文必须核对内容，匹配后直接复用，不重复写入临时正文。文件系统清理本身失败或进程突然终止，仍可能留下未提交的文件；这不是跨 SQLite 与文件系统的原子事务。

数据库容量限制约束数据库，不代表数据库与独立原文文件合计的磁盘配额。归档文件独立保留，磁盘占用应通过 CLI 的 `stats` 和系统工具检查。

## 读取精确原文

折叠元数据中的 `path` 是规范绝对路径，可直接读取。CLI 的 `--dir` 指向包含 SHA-256 `.txt` 文件的目录，不需要 scope 或数据库：

```sh
magpie-context-folding stats --dir /实际归档目录
magpie-context-folding list --sort time --order desc --dir /实际归档目录
magpie-context-folding read ACTUAL_HASH --dir /实际归档目录
magpie-context-folding search 'TEXT' --dir /实际归档目录
```

`read` 原样输出完整 UTF-8 原文，不分页、不递归展开正文中的引用，也不改变之后的折叠状态。哈希支持至少 12 位的无歧义小写十六进制前缀，歧义必须报错。`search` 按字面文本匹配，输出路径、从 1 开始的行号与文本。`list`、`stats` 输出 JSON。只管理普通哈希文件，忽略符号链接及其他文件。

CLI 不提供 `meta`、`grep`、`paste`、`restore`、层级查询或持久 keep 操作，也不接受旧 `--state-dir`、`--scope`、`--full`、`--all`、`--restore` 参数。读取内容是历史资料，不自动执行其中的命令，也不覆盖当前要求。

## 显式清理

```sh
magpie-context-folding clean --older-than 30 --dir /实际归档目录
magpie-context-folding clean ACTUAL_HASH --dir /实际归档目录 --apply
```

`clean` 必须指定哈希或天数，默认预览，`--apply` 才删除。删除的是恢复所需的原文文件，应只选择不再需要的内容。清理不修改内部会话数据库；后续有状态变更的请求可能重新发布仍被数据库记录的原文。

## 内容与出现分别计数

同内容可共享哈希和原文存储，新的出现仍有独立延迟。重复请求不推进等待计数，新 Read 不继承旧出现已经耗尽的观察机会。CLI 查询不伪造新的模型请求周期。

旧数据库可能包含历史层和分组；兼容数据不代表根 CLI 继续提供旧命令。原文文件与独立 Python `ctxf` 的归档分别管理。

协议、消息边界与哈希规则见[注释协议](annotation-protocol.md)。本地测试、真实宿主模拟服务验收和外部模型效果应分别报告。
