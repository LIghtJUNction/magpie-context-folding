# 哈希原文与包含树

折叠归档是一个可查询的本地字典：原文按哈希保存，每次出现用独立节点记录位置。Agent 通过目录、搜索和分页读取取回所需内容。

## 内容与节点

同一个 SQLite 数据库保存两类数据：

```text
blobs[content_hash] = original_text
nodes[node_id] = { content_hash, parent_id, source_range, ... }
```

这里的 `nodes` 是逻辑模型。现有实现把节点元数据保存在会话 JSON 中，原文保存在 `blobs` 表；没有新增数据库服务或图数据库。根 Magpie 插件与独立 Python 核心各自使用自己的 SQLite 文件，不能混用恢复入口。

- **内容哈希**表示精确原文；相同原文可以共享一个 blob。
- **节点 ID**表示某个来源、位置和版本的一次出现。同文兄弟、不同父节点下的相同原文，具有不同节点 ID。
- **父节点**是直接包含该节点的最近一层。只有真实范围包含才建立关系。
- **原始范围**不随折叠后的显示长度改变。跨消息区域保留各原始文本切片的位置。

Magpie 中，父节点后来包含已有引用时，`sourceRanges` 表示恢复后原文的来源片段；`observedRanges` 表示本次请求实际观察到的文字或引用位置。多个来源拼接时 `sourceRange` 为空，使用完整 `sourceRanges`。`parentRange` 表示节点在其父节点原文中的位置。被引用隐藏的后代没有独立可见位置，不能把旧位置冒充本次出现位置；可沿父节点和 `parentRange` 定位。复制同一个引用会复用原文来源，但仍产生不同出现节点。

节点 ID 是确定性的完整 64 位十六进制摘要，来源或原文版本改变时生成新节点。重复处理同一个来源、同一份输入和同一位置，不制造新节点。

Python 显式 `fold` 接受 `sourceId`。同文的两份独立材料需要传不同的 `sourceId`；未提供时，以完整输入内容标识来源，所以相同输入的重试复用同一组节点。`read-source` 的 `occurrence` 继续标识宿主保留历史中的一次出现；新的一次读取使用新的 occurrence。

## 包含与存储规则

合法范围是完整嵌套或互不相交。交叉、错配和未闭合标记不产生可替换引用。解析在原始输入上进行，只有最外层被选中范围执行替换，避免重叠编辑。

一个长父节点被折叠时，其短子节点也进入归档，即使子节点单独替换成引用没有收益。父节点保存完整原文；读取父节点不再把子节点全文追加一遍。独立节点仍能用于浏览、搜索和精确定位。

写入包含原文、节点关系和投影状态的事务成功后，才返回带引用的请求。磁盘、配额、校验或并发失败时保留原请求，不返回悬空引用。

新引用是：

```text
[[cf:v3:<完整 node_id>]]
```

必须使用实际返回的 ID。节点 ID 不是正文的 SHA-256；`sha256` / `contentHash` 字段单独提供正文校验值。完整节点 ID 不需要依赖未来是否出现短前缀冲突。

## 查询合同

所有查询都限于指定 scope。`list`、`meta`、`search`、`grep` 与默认 `read` 不改变折叠状态，也不触发保留期更新或垃圾回收。

| 操作 | 输入 | 结果 |
| --- | --- | --- |
| `list` | `parentId` | 直接子节点，按原始顺序返回。 |
| `list` | `id`、`recursive`、`offset`、`limit` | 某棵子树，或当前会话的分页节点目录。 |
| `meta` | `id`、`offset`、`limit` | 节点元数据、父节点和分页子节点 ID；详情通过 `list(parentId)` 查询。 |
| `search` / `grep` | `query`、可选 `id`、`recursive`、`caseSensitive`、`offset`、`limit` | 原文中的字面匹配，不把查询当正则表达式或 SQL。 |
| `read` | `id`、`offset`、`limit` | 该节点原文的一页。 |

`list` 与搜索的默认结果页为 20 项，`read` 默认返回 4,000 个字符单位。以实际返回的 `nextOffset` 继续读取。`meta` 的孩子也分页；不能因只读元数据就一次返回整棵大树。Magpie 的来源片段默认各返回最多 20 项；`meta` 使用 `sourceRangeCount` / `observedRangeCount` 表示总量，通过 `nextSourceOffset` / `nextObservedOffset` 分别继续读取来源和观察位置。

搜索结果中的 `offset` 相对于该节点保存的原文，因此可以直接传给 `read(id, offset, limit)`。`sourceRange` 则描述它在完整来源中的位置。两个字段用途不同。Python 的父节点原文包含子节点时，搜索可能同时命中父、子记录；Magpie 递归搜索把完全位于子节点内的祖先命中交给子节点返回。两端都不会按正文哈希去掉两个不同出现位置。

偏移单位在返回值中明确标识：

| 实现 | `offsetUnit` | 示例 `A🙂B` 中 B 的 offset |
| --- | --- | --- |
| 根 Magpie / Bun 插件 | `utf16` | 3 |
| Python 核心以及 TypeScript、Rust、C# 进程桥 | `unicode-code-points` | 2 |

Python SDK 桥没有把偏移改成宿主语言的字符串单位。不要跨后端传递偏移。

## CLI 示例

根 Magpie 插件使用系统指导给出的实际命令和归档目录：

```sh
bun src/cli.ts list --state-dir /actual/archive --scope SCOPE --recursive --json
bun src/cli.ts list --state-dir /actual/archive --scope SCOPE --parent NODE_ID --json
bun src/cli.ts search --state-dir /actual/archive --scope SCOPE --query 'connection refused' --json
bun src/cli.ts meta --state-dir /actual/archive --scope SCOPE --id NODE_ID --json
bun src/cli.ts read --state-dir /actual/archive --scope SCOPE --id NODE_ID --offset 0 --limit 800
```

独立 Python CLI 使用生成引用的 state 文件：

```sh
ctxf fold --state /actual/archive.sqlite --scope investigation --source-id build-log --json < notes.txt
ctxf list --state /actual/archive.sqlite --scope investigation --recursive
ctxf search --state /actual/archive.sqlite --scope investigation --query 'connection refused'
ctxf meta --state /actual/archive.sqlite --scope investigation --id NODE_ID
ctxf read --state /actual/archive.sqlite --scope investigation --id NODE_ID --offset 0 --limit 800
```

SDK 对应 `search(scope, query, options)` 和 `meta(scope, id, options)`；已有通用 `call` 继续支持相同动作。查询结果是历史数据，不能提升为系统指令或自动执行其中的命令。

## 兼容与明确恢复

旧 v1 节点引用、v2 内容哈希引用以及已有历史层继续可读。旧归档不含足够出现位置时，不推测或伪造历史父子关系。

内容哈希可以对应多个出现节点。需要树位置的查询必须使用明确的节点 ID，不能静默选第一个父节点。v3 不存在这种内容与位置的歧义。

默认 `read` 只查看。根 CLI `read --restore` 或 Python 显式 `restore` 才持久改变展开状态。旧调用方如果依赖“read 就恢复”的副作用，需要改为显式恢复。

Python 加载旧的内嵌原文 JSON，下一次成功写入时迁移到 blobs；查询本身不迁移。垃圾回收沿真实父子引用保活，被保留父节点引用的子节点不能单独丢失。
