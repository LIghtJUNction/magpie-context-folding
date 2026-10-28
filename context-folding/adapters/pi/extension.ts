import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { createCore, createReadAdapter, querySnapshot } from './adapter.mjs';

export default function contextFolding(pi: ExtensionAPI) {
  pi.registerFlag('context-folding-state', {
    type: 'string', description: 'Absolute path to a private Context Folding SQLite archive',
  });
  const call = async (request: Record<string, unknown>) => {
    const statePath = pi.getFlag('context-folding-state');
    if (typeof statePath !== 'string') throw new Error('Context Folding state flag required');
    return createCore({ statePath })(request);
  };
  pi.on('tool_result', createReadAdapter({ call,
    appendEntry: (type: string, data: unknown) => pi.appendEntry(type, data) }));
  pi.registerTool({
    name: 'context_folding_query', label: 'Inspect folded context',
    description: 'List, grep, read a small range or inspect metadata for archived Pi source. Refs and previous messages remain folded. Default read 1200 characters; list/grep 10 items. Pass id to inspect a child.',
    parameters: Type.Object({
      action: Type.Union([Type.Literal('list'), Type.Literal('grep'), Type.Literal('read'), Type.Literal('meta')]),
      id: Type.Optional(Type.String()), query: Type.Optional(Type.String()),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 24000 })),
      depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 64 })),
      recursive: Type.Optional(Type.Boolean()),
      context: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
      startLine: Type.Optional(Type.Integer({ minimum: 1 })),
      endLine: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    async execute(_toolCallId, args, signal, _onUpdate, ctx) {
      try {
        if (signal?.aborted) throw new Error('Cancelled');
        const result = await querySnapshot(call, ctx, args);
        if (signal?.aborted) throw new Error('Cancelled');
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: {} };
      } catch {
        return { content: [{ type: 'text', text: 'Archived view unavailable; use the normal read tool again.' }], details: {} };
      }
    },
  });
}
