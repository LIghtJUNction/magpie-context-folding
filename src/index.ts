import { execute } from './tool.js';

export async function ContextFoldingPlugin() {
  return {
    tool: {
      context_folding: {
        description: 'Reversible context folding. Use scope from the request guide (required except global stats). list IDs; mark finished work foldable with summary, active requirements keep. keep/unmarked restores originals. read original/layer; paginate nextOffset, unfold via previousId. paste ID to new absolute file path (UTF-8). status: cost gate; stats: counters/conditional savings; forget: dispose only after keep.',
        args: {
          type: 'object',
          properties: {
          scope: { type: 'string', description: 'Session capability from context-folding scope=...; do not share.' },
          action: { type: 'string', enum: ['list', 'mark', 'read', 'paste', 'status', 'stats', 'forget'] },
          marks: { type: 'array', items: { type: 'object', properties: {
            id: { type: 'string' }, disposition: { type: 'string', enum: ['foldable', 'keep', 'unmarked'] }, summary: { type: 'string', description: 'Brief supported state of this entry: goal/constraints/done/blocker/next/evidence as relevant. Label user quotes, assistant judgments and tool evidence; never infer authorization. Omit repetition, stale one-shot instructions and unknown fields. Archive holds details.' },
          }, required: ['id', 'disposition'], additionalProperties: false } },
          id: { type: 'string' }, layer: { type: 'string', description: 'original or a layer ID from list/read' },
          path: { type: 'string', description: 'paste: absolute path to a new file; parent must exist. Omit offset/limit for full text.' },
          offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 24000 },
          },
          required: ['action'],
          additionalProperties: false,
        },
        execute,
      },
    },
  };
}

export default ContextFoldingPlugin;
