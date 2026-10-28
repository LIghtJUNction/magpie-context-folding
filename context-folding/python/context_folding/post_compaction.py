"""Deliver a short folding reminder after the host has compacted a session.

Claude's SessionStart(source=compact) event can add context to the next request.
This hook needs no archive, session binding, or writable state directory.
"""
from __future__ import annotations

import json
import sys


POST_COMPACTION_REMINDER = """<context-folding-post-compaction>
刚刚发生了上下文压缩。如果这是自动压缩，说明本轮主动折叠未能避免兜底压缩；请把它作为未充分善用 magpie-context-folding 的反馈，及时改进。手动压缩也应在恢复任务后继续主动折叠。
继续用户的原任务。在普通输出中，主动用独占一行的 <!-- @context-fold begin LABEL --> 和 <!-- @context-fold end LABEL --> 包住已完成、以后只需回查的长过程；两个 LABEL 必须相同，不要嵌套，每个阶段完成后及时闭合。当前结论、用户约束和待办留在标记外。
已接入的对话折叠器会在后续正常请求满足延迟及净收益条件时自动保存原文并折叠，无需额外调用来触发，也不要每轮查询状态。不要为演示制造长文本，不要等上下文被动压缩后才使用标记。
这段提醒不会恢复已经丢失的原文；需要细节时按实际存档引用回查，不要猜测或重建被压缩的内容。
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
