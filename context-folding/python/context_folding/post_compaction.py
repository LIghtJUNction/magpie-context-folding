"""Deliver a short folding reminder after the host has compacted a session.

Claude's SessionStart(source=compact) event can add context to the next request.
This hook needs no archive, session binding, or writable state directory.
"""
from __future__ import annotations

import json
import sys


POST_COMPACTION_REMINDER = """<context-folding-post-compaction>
刚刚发生了上下文压缩。这是回退信号：继续用户的原任务，并在接下来的普通输出里先写清已知结论、约束、失败和下一步，再把已完成、可能要回查的长过程放在其下方的闭合标记内。
以后每完成一段实质性工作，先在标记外写一段简明且可独立理解的当前摘要，再紧接着用 <!-- @context-fold begin task-details --> 和 <!-- @context-fold end task-details --> 包住较长的支撑过程。总任务外层标记可选：多里程碑回放显示，它比只折里程碑几乎没有额外字节收益；若采用，只用于归组，始终把当前摘要放在外面，任务完成后闭合并在其后写总总结。未闭合的标记不能折叠。
已接入折叠器的宿主会在后续正常请求满足延迟与净收益条件时自动保存原文并折叠；不要调用状态查询来触发，也不要为演示制造文本。不同宿主未必能报告压缩事件；这条提醒只在实际收到压缩事件的宿主生效。
提醒不恢复已经丢失的内容。需要旧细节时只按真实存档引用回查，不要猜测或重建。
</context-folding-post-compaction>"""


def claude_hook(event: object) -> dict:
    """Return context only for the real, completed compaction boundary."""
    if not isinstance(event, dict):
        return {}
    if event.get("hook_event_name") != "SessionStart" or event.get("source") != "compact":
        return {}
    return {"hookSpecificOutput": {
        "hookEventName": "SessionStart",
        "additionalContext": POST_COMPACTION_REMINDER,
    }}


def main() -> int:
    """Read the host event; malformed/unrelated events never interrupt work."""
    try:
        output = claude_hook(json.load(sys.stdin))
    except (ValueError, OSError, RecursionError):
        return 0
    if output:
        print(json.dumps(output, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
