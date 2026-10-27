import { getCostClass } from './defaults.js';

const textEncoder = new TextEncoder();

export type PayloadCost = {
  bytes: number;
  approxTokens: number;
  costClass: 'cheap' | 'moderate' | 'heavy' | 'extreme';
};

/** Measure UTF-8 byte length in both Node and extension runtimes. */
export function getUtf8ByteLength(value: string): number {
  if (!value) {
    return 0;
  }
  return typeof Buffer !== 'undefined'
    ? Buffer.byteLength(value, 'utf8')
    : textEncoder.encode(value).length;
}

/** Estimate cost for an already-serialized payload.

This remains intentionally approximate because Browser Bridge must stay
model-agnostic across MCP and CLI clients. */
export function estimateSerializedPayloadCost(serialized: string): PayloadCost {
  const bytes = getUtf8ByteLength(serialized);
  const approxTokens = bytes === 0 ? 0 : Math.ceil(bytes / 4);
  return {
    bytes,
    approxTokens,
    costClass: getCostClass(approxTokens),
  };
}

/** Serialize a JSON payload for transport-oriented cost estimation. */
export function serializeJsonPayload(value: unknown): string {
  if (typeof value === 'undefined') {
    return '';
  }
  return JSON.stringify(value) ?? '';
}

/** Estimate cost for a JSON-serializable payload. */
export function estimateJsonPayloadCost(
  value: unknown,
  serialized: string = serializeJsonPayload(value)
): PayloadCost {
  return estimateSerializedPayloadCost(serialized);
}
