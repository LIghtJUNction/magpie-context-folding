# 在编程 Agent 中查看折叠效果

插件把发给模型的请求副本变短；客户端保留的聊天记录仍然是原文。下面的显示接入让人看到插件实际处理的请求，不要求模型再生成一段折叠回执。

## 哪一种显示会改变

| 显示对象 | 实际来源 | 折叠后的行为 |
| --- | --- | --- |
| 聊天历史与工具输出正文 | 客户端已经保存的 transcript | Magpie 不改写它，不会自动出现可点击的折叠块。 |
| 客户端原生上下文用量 | 客户端使用的供应商 usage，部分位置还包含本地估算 | 正确透传真实 usage 后，后续响应可能体现较小的输入；百分比取整、缓存及新增消息会影响显示。 |
| 本插件状态行或通知 | 最近记录的请求前后大小、折叠段数及匹配响应 | 能明确看到这一轮的转换，不依赖模型描述。 |
| 原生 `Context compacted` / `/compact` 提示 | 客户端自己的压缩生命周期 | 代理折叠不会制造该事件。 |

Claude Code 的状态行使用最近 API 响应，`/context` 还可加入该响应之后新增消息的估算。其自定义状态行在本地执行，不消耗 API token，见 [官方 statusline 文档](https://code.claude.com/docs/en/statusline)。Codex 的命令 hook 可用 `systemMessage` 在 UI / event stream 展示消息，见 [官方 hooks 文档](https://learn.chatgpt.com/docs/hooks)。

## 先确认正在读取同一个归档

以下命令来自根 npm 包的 Magpie CLI，需要安装包含本修复的源码或版本，并让 Bun 可执行文件位于命令的 PATH。开发目录中可将命令替换为 `bun /absolute/path/magpie-context-folding/src/cli.ts ...`。

```sh
magpie-context-folding sessions
magpie-context-folding statusline
magpie-context-folding statusline --scope S
magpie-context-folding statusline --scope S --json
```

把 `S` 替换为 `sessions` 返回的实际 scope。`sessions` 是主动枚举命令，会显示 scope；状态行、hook 消息和 HTML 报告不显示它。`statusline` 不带 scope 时显示**全局累计**，不会选择最近会话并冒充当前会话。

CLI 与 Magpie 必须能读取同一台机器上的同一归档。默认使用 `$XDG_DATA_HOME/magpie-context-folding`，或 `~/.local/share/magpie-context-folding`；自定义位置需要为两边设置相同的 `MAGPIE_CONTEXT_FOLDING_STATE_DIR`。在容器、远程网关或不同系统用户下运行时，需要明确提供同一个可读取的状态目录。独立 Python `ctxf` 的归档不是这份 Magpie 状态库。

`sessions`、`statusline` 与报告只读取元数据，不展开正文、不增加恢复次数、不修改折叠状态。没有状态库时，不会为了显示而创建一个空库。

## Claude Code：持续状态行

在 Claude Code 的设置中合并下列 `statusLine` 字段。若已有状态行，可由原脚本调用本命令并组合输出。

```json
{
  "statusLine": {
    "type": "command",
    "command": "magpie-context-folding statusline --client",
    "refreshInterval": 1
  }
}
```

`--client` 从标准输入读取客户端 JSON 中的 `session_id`，仅当它与 Magpie 记录的会话标识匹配且对应唯一 scope 时显示该会话。Magpie 的 `session` 还与 origin、agent、cwd 一起决定 scope；不能假设客户端 ID 一定就是代理 ID。无法匹配、出现多个匹配或旧数据没有会话映射时，显示“当前会话未绑定”。

如果你的网关使用不同的会话 ID，可用 `sessions` 检查并确认目标 scope，然后明确指定：

```json
{
  "statusLine": {
    "type": "command",
    "command": "magpie-context-folding statusline --scope S",
    "refreshInterval": 1
  }
}
```

也可通过 `MAGPIE_CONTEXT_FOLDING_SCOPE` 设置所选 scope；显式 `--scope` 优先。固定 scope 对应固定会话，新会话需要重新绑定。命令旁的时间始终表示最近记录时间，不能把旧会话状态当作新请求的状态。

## Codex：完成一轮后显示通知

支持生命周期 hooks 的 Codex 版本可在 `.codex/hooks.json` 或用户级 hooks 文件中合并：

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "magpie-context-folding hook",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

在 Codex 的 `/hooks` 中按客户端原生流程查看并信任该命令。hook 使用与 `--client` 相同的会话匹配规则，也支持 `--scope S` 或 `MAGPIE_CONTEXT_FOLDING_SCOPE`。无法确认绑定时保持安静。

hook 只发送 `systemMessage`，不发送 `additionalContext`、阻塞决定或继续执行指令。它只通知最近已匹配成功、含折叠、完成时间在五分钟内且尚未展示的记录；长时间生成的请求按完成时间判断新鲜度。旧数据没有完成时间时采用记录时间。游标与归档分开，不会改变归档正文、恢复计数或折叠决定。通知明确写“最近记录”：它不把之后未记录的请求归到这条记录，也不是 Codex 原生 compaction。

不支持此 hook 的客户端，也可在另一个终端查看：

```sh
watch -n 1 magpie-context-folding statusline --scope S
```

## 数字和状态怎样解释

每条新记录包含完整 hook 输入与返回投影的 UTF-8 JSON 字节数。显示端计算：

```text
before_estimate = ceil(before_bytes / 4)
after_estimate  = ceil(after_bytes / 4)
net_reduction  = before_estimate - after_estimate
```

返回投影包括系统指导、恢复路径与引用的开销。净减少可以为负；重放已经折叠的投影可能为零。不会从“归档里保存了多少原文”反推本轮节省。已有引用数量与本轮替换段数分开，归档中保留的旧内容也不会冒充当前输入。

| 状态 | 能确认什么 |
| --- | --- |
| `pending` | 归档事务已提交，hook 已生成返回投影；尚未收到匹配的成功回调。 |
| `confirmed` | 宿主返回 `success: true`，并提供与投影指纹匹配的请求。 |
| `failed` | 宿主明确报告该请求失败。 |
| `unverified` | 成功状态缺失，或回调中的请求与投影无法匹配。 |

每次调用有独立记录 ID，因此较早请求的迟到响应不能确认或覆盖新请求。`confirmed` 也不是供应商计费 token 的证明：字节 / 4 始终是估算，真实 usage 保持供应商原值。

只有通过现有完整历史和恢复入口检查的请求才写入上述观测。配置禁用、请求不支持、恢复不可用或事务失败等提前返回，不会生成新的成功记录。看记录时间；缺失不能按零、成功或“从未折叠”解释。报告与 CLI 是已记录处理过程的窗口，不是所有网络流量的抓包器。

历史归档没有前后大小或观测状态时，明确显示“未记录”；不会补造历史数据。新版本处理下一次符合条件的请求后，才会产生新的对比。

## 离线报告

```sh
magpie-context-folding report --scope S --output /absolute/new-folding-report.html
```

输出文件必须尚不存在。报告识别当前注释协议的成功折叠、宽限期与无可折叠标记，显示最近记录的投影字节、估算 token、替换/已有引用/等待数量及响应状态，同时兼容旧版归档。它不包含原文、路径、模型名、会话 scope 或内部记录 ID。
