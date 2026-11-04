import { PROTOCOL_VERSION } from '../contracts.js';
import type { ActionEnvelope, ActionId } from '../contracts.js';
import { decodeCbor, encodeCbor } from './cbor.js';
import { actionIdSchema, envelopeFromWire, envelopeToWire } from './schema.js';

export class EnvelopeDecodeError extends Error {
  constructor(
    message: string,
    readonly reason: 'version' | 'reference',
    readonly id?: ActionId,
  ) {
    super(message);
    this.name = 'EnvelopeDecodeError';
  }
}

/** Text-keyed records follow the logical contract; actor fields are 16-byte strings. */
export function encodeEnvelope(envelope: ActionEnvelope): Uint8Array {
  if (envelope.protocolVersion !== PROTOCOL_VERSION)
    throw new EnvelopeDecodeError('Unsupported envelope version', 'version', envelope.id);
  return encodeCbor(envelopeToWire(envelope));
}

export function decodeEnvelope(bytes: Uint8Array): ActionEnvelope {
  let id: ActionId | undefined;
  try {
    const wire = decodeCbor(bytes);
    if (wire && typeof wire === 'object' && !Array.isArray(wire) && !(wire instanceof Uint8Array)) {
      const fields = wire as Record<string, unknown>;
      try {
        id = actionIdSchema(fields.id, 'decode') as ActionId;
      } catch {
        // Malformed records with no trustworthy identity remain collection diagnostics.
      }
      if (typeof fields.protocolVersion === 'bigint' && fields.protocolVersion !== 3n)
        throw new EnvelopeDecodeError('Unsupported envelope version', 'version', id);
    }
    return envelopeFromWire(wire) as ActionEnvelope;
  } catch (error) {
    if (error instanceof EnvelopeDecodeError) throw error;
    throw new EnvelopeDecodeError(
      error instanceof Error ? error.message : 'Invalid envelope',
      'reference',
      id,
    );
  }
}
