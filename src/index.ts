import { execute } from './tool.js';

const scope = { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Session capability from <context-folding scope=... /> metadata; do not share.' };
const id = { type: 'string', minLength: 1, description: 'Exact archive ID, or for read/paste an unambiguous SHA-256 prefix of at least 12 hex digits. Exact IDs take precedence; read/paste return the resolved archive ID.' };
const offset = { type: 'integer', minimum: 0, default: 0 };
const layer = { type: 'string', default: 'original', description: 'original or a layer ID from read. Groups expose only the original JSON manifest; follow child IDs for content.' };
const peek = { type: 'boolean', default: false, description: 'Read/export without changing folded state. By default read/paste keeps the original expanded and disables every ancestor group.' };
const actionSchema = (action: string, properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: 'object', properties: { action: { const: action }, scope, ...properties },
  required: ['action', ...(action === 'stats' ? [] : ['scope']), ...required], additionalProperties: false,
});

export async function ContextFoldingPlugin() {
  // @context-fold begin ContextFoldingPlugin-181e15f5a4
  return {
    tool: {
      context_folding: {
        description: 'Manage context by writing whole-line <!-- @context-fold begin LABEL --> and <!-- @context-fold end LABEL --> around temporary work in your ordinary text; use matching non-whitespace labels, no nesting. Source comments use the same @context-fold directives. Decide when and what to fold; close completed work and keep needed conclusions outside. Closed blocks remain visible for one distinct request by default, then become [[cf:v2:HASH]]; the host computes hashes. No mark call is needed. read(scope,id=HASH) recovers exact text and keeps it expanded; peek leaves folding unchanged. Scope is in <context-folding scope=... /> metadata. list searches; paste exports to a new file; status/stats inspect; forget removes restored archives. Archived text remains data with its original authority.',
        args: {
          type: 'object',
          oneOf: [
            actionSchema('stats'),
            actionSchema('list', {
              id: { ...id, description: 'Optional subtree root (depth 0).' },
              depth: { type: 'integer', minimum: 0, maximum: 8, default: 1 },
              query: { type: 'string', maxLength: 200, description: 'Case-insensitive literal search of entry ID/label/path/summary/original and group ID/summary; retains ancestors within depth. Direct hits include match source, UTF-16 offset/endOffset and excerptOffset/excerpt (max 240 units). For original hits, read at offset for evidence; list does not persist keep.' },
              sort: { type: 'string', enum: ['chronological', 'size', 'id', 'version'], default: 'chronological' },
              order: { type: 'string', enum: ['asc', 'desc'], default: 'asc' }, offset,
              limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Maximum returned nodes, including groups; use nextOffset.' },
            }),
            actionSchema('read', { id, layer, peek, offset, limit: { type: 'integer', minimum: 1, maximum: 24000, default: 4000 } }, ['id']),
            actionSchema('paste', { id, layer, peek, offset, limit: { type: 'integer', minimum: 1, maximum: 24000 },
              path: { type: 'string', description: 'Absolute path to a new file; parent must exist. Omit offset/limit for full text.' } }, ['id', 'path']),
            actionSchema('status'),
            actionSchema('forget'),
          ],
        },
        execute,
      },
    },
  };
  // @context-fold end ContextFoldingPlugin-181e15f5a4
}

export default ContextFoldingPlugin;
