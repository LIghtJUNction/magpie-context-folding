import { stripGuidanceInPlace } from './guidance.js';
import { stripRecoveryMetadataInPlace } from './recovery.js';
import type { Protocol } from './protocol.js';

type Body = Record<string, unknown>;
const record = (value: unknown): value is Body => !!value && typeof value === 'object' && !Array.isArray(value);

/** Clean plugin instructions while sharing the large, immutable conversation history. */
export function cleanRequestBody(body: Body, protocol: Protocol): Body {
  const result = { ...body };
  if (protocol === 'chat' && Array.isArray(body.messages)) result.messages = [...body.messages];
  if (protocol === 'gemini' && record(body.config)) result.config = { ...body.config };
  stripRecoveryMetadataInPlace(result, protocol);
  stripGuidanceInPlace(result, protocol);
  return result;
}
