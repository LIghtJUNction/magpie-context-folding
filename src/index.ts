import { execute } from './tool.js';

export async function ContextFoldingPlugin() {
  return {
    tool: {
      context_folding: {
        description: 'Manage reversible historical context. Get scope from context-folding guide. list finds IDs; mark atomically sets foldable with a factual summary, keep (never auto-fold, restores original), or unmarked. Never mark active requirements foldable. read retrieves one original or saved layer; follow previousId recursively to original, paginate via nextOffset. status explains cost gate. forget disposes a finished scope only after all folded entries have been restored with keep.',
        args: {
          type: 'object',
          properties: {
          scope: { type: 'string', description: 'Session capability from context-folding scope=...; do not share.' },
          action: { type: 'string', enum: ['list', 'mark', 'read', 'status', 'forget'] },
          marks: { type: 'array', items: { type: 'object', properties: {
            id: { type: 'string' }, disposition: { type: 'string', enum: ['foldable', 'keep', 'unmarked'] }, summary: { type: 'string' },
          }, required: ['id', 'disposition'], additionalProperties: false } },
          id: { type: 'string' }, layer: { type: 'string', description: 'original or a layer ID from list/read' },
          offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 24000 },
          },
          required: ['scope', 'action'],
          additionalProperties: false,
        },
        execute,
      },
    },
  };
}

export default ContextFoldingPlugin;
