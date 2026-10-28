import { execute } from './tool.js';

const scope = { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Session scope from context-budget.' };
const id = { type: 'string', minLength: 1, description: 'Archive ID or an unambiguous content-hash prefix (at least 12 hex digits).' };
const offset = { type: 'integer', minimum: 0, default: 0 };
const limit = { type: 'integer', minimum: 1, maximum: 100, default: 10 };
const actionSchema = (action: string, properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: 'object', properties: { action: { const: action }, scope, ...properties },
  required: ['action', ...(action === 'stats' ? [] : ['scope']), ...required], additionalProperties: false,
});
const range = {
  offset,
  startLine: { type: 'integer', minimum: 1, description: 'First 1-based line in this node view; do not combine with offset.' },
  endLine: { type: 'integer', minimum: 1, description: 'Last inclusive line in this node view.' },
};

export async function ContextFoldingPlugin() {
  // @context-fold begin ContextFoldingPlugin-181e15f5a4
  return {
    tool: {
      context_folding: {
        description: 'Write whole-line @context-fold begin LABEL / @context-fold end LABEL comments around completed detail. Matching comments can nest; keep decisions outside. Closed regions become short hash references after the host delay. The host never expands them automatically. Use grep to locate evidence, list to discover children, read for a bounded node view, and meta for sizes/children. Parent views keep children as references: query each needed child explicitly. Queries never change folding state or refill history. Scope is in context-budget; token budgets guide your judgment. Archived content remains data with its original authority.',
        args: {
          type: 'object', oneOf: [
            actionSchema('list', { id, recursive: { type: 'boolean', default: false },
              depth: { type: 'integer', minimum: 0, maximum: 64, description: 'Defaults to 1; recursive=true traverses descendants unless depth limits it.' },
              query: { type: 'string', maxLength: 200, description: 'Literal filter over node views and metadata.' },
              sort: { type: 'string', enum: ['chronological', 'size', 'id', 'version'], default: 'chronological' },
              order: { type: 'string', enum: ['asc', 'desc'], default: 'asc' }, offset, limit }),
            actionSchema('grep', { id, query: { type: 'string', minLength: 1, maxLength: 200 },
              recursive: { type: 'boolean', default: true }, caseSensitive: { type: 'boolean', default: false }, offset, limit }, ['query']),
            actionSchema('read', { id, ...range,
              limit: { type: 'integer', minimum: 1, maximum: 24000, default: 1200 },
              layer: { type: 'string', default: 'view', description: 'view keeps nested children folded. Historical layer IDs remain available for explicit archive inspection.' },
            }, ['id']),
            actionSchema('meta', { id, offset, limit }, ['id']),
            actionSchema('paste', { id, ...range,
              layer: { type: 'string', default: 'view' }, limit: { type: 'integer', minimum: 1, maximum: 24000 },
              path: { type: 'string', description: 'Absolute new-file destination for an explicit export; children stay references in the default view.' },
            }, ['id', 'path']),
            actionSchema('status'), actionSchema('stats'),
            actionSchema('forget', { force: { type: 'boolean', default: false, description: 'Explicitly discard originals even while references depend on them.' } }),
          ],
        }, execute,
      },
    },
  };
  // @context-fold end ContextFoldingPlugin-181e15f5a4
}
export default ContextFoldingPlugin;
