import { DEFAULT_INGEST_LIMITS, IngestDataError, finish, guardDecode } from '../ingest/work.js';
import type { Work } from '../ingest/work.js';
import { PROTOCOL_VERSION } from '../contracts.js';
import type { ActionEnvelope, ActionId } from '../contracts.js';
import { CborDecodeError, decodeCborSteps, encodeCbor } from './cbor.js';
import { actionIdSchema, envelopeFromWire, envelopeToWire, EnvelopeSchemaError } from './schema.js';

export class EnvelopeDecodeError extends Error {
  readonly stage = 'envelope';
  get code(): string {
    return this.reason;
  }
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
  return finish(decodeEnvelopeSteps(bytes, DEFAULT_INGEST_LIMITS.depth));
}

export function* decodeEnvelopeSteps(
  bytes: Uint8Array,
  depth: number,
  operations = DEFAULT_INGEST_LIMITS.decodeOperations as number,
): Work<ActionEnvelope> {
  let id: ActionId | undefined;
  try {
    const wire = yield* guardDecode(decodeCborSteps(bytes, depth), operations, 'envelope');
    if (wire && typeof wire === 'object' && !Array.isArray(wire) && !(wire instanceof Uint8Array)) {
      const fields = wire as Record<string, unknown>;
      try {
        id = actionIdSchema(fields.id, 'decode') as ActionId;
      } catch (error) {
        if (!(error instanceof EnvelopeSchemaError)) throw error;
        // Malformed records with no trustworthy identity remain collection diagnostics.
      }
      if (typeof fields.protocolVersion === 'bigint' && fields.protocolVersion !== 3n)
        throw new EnvelopeDecodeError('Unsupported envelope version', 'version', id);
    }
    return envelopeFromWire(wire) as ActionEnvelope;
  } catch (error) {
    if (error instanceof EnvelopeDecodeError) throw error;
    if (
      !(
        error instanceof CborDecodeError ||
        error instanceof EnvelopeSchemaError ||
        (error instanceof IngestDataError && error.stage === 'envelope')
      )
    )
      throw error;
    throw new EnvelopeDecodeError(error.message, 'reference', id);
  }
}
