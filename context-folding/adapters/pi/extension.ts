import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { createCore, createReadAdapter, restoreOriginal } from './adapter.mjs';

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
    name: 'context_folding_restore', label: 'Restore read snapshot',
    description: 'Recover the exact original text of a folded Pi read snapshot in the active session branch. Returns archived text only; does not read or modify files. Restore before using literal source in edit/write tools, which retain normal tool approvals.',
    parameters: Type.Object({ id: Type.String() }),
    async execute(_toolCallId, { id }, signal, _onUpdate, ctx) {
      try {
        if (signal?.aborted) throw new Error('Cancelled');
        const text = await restoreOriginal(call, ctx, id);
        if (signal?.aborted) throw new Error('Cancelled');
        return { content: [{ type: 'text', text }], details: {} };
      } catch {
        // Do not disclose archive contents, paths, or diagnostics on failure.
        return { content: [{ type: 'text', text: 'Snapshot unavailable; use the normal read tool again.' }], details: {} };
      }
    },
  });
}
