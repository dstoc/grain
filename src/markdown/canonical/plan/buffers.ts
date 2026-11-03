import type { TapeId } from '../types.js';
import type {
  DraftTextBuffer,
  InsertionSlot,
  InsertionSlotTarget,
  InsertedPiece,
} from './types.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Owns immutable action-local text and the insertion slots that locate it. */
export class DraftTextBuffers {
  private readonly buffers = new Map<string, DraftTextBuffer>();
  private insertionSlotOrder = 0;

  constructor(private readonly allocateId: () => string) {}

  create(anchor: InsertionSlotTarget, text: string): InsertedPiece {
    const { parentBufferId, parentBufferOffset, ...slot } = anchor;
    const bufferId = this.allocateId();
    const insertionAnchor: InsertionSlot = { ...slot, order: this.insertionSlotOrder++ };
    assert(
      (parentBufferId === undefined) === (parentBufferOffset === undefined),
      'buffer insertion requires a complete parent slot',
    );
    if (parentBufferId !== undefined && parentBufferOffset !== undefined) {
      const parent = this.buffers.get(parentBufferId);
      assert(parent, `missing parent action-local text buffer ${parentBufferId}`);
      assert(
        Number.isInteger(parentBufferOffset) &&
          parentBufferOffset >= 0 &&
          parentBufferOffset <= parent.text.length,
        `insertion is outside parent action-local text buffer ${parentBufferId}`,
      );
    }
    this.buffers.set(bufferId, {
      text,
      anchor: insertionAnchor,
      ...(parentBufferId === undefined ? {} : { parentBufferId }),
      ...(parentBufferOffset === undefined ? {} : { parentBufferOffset }),
    });
    return {
      kind: 'inserted',
      bufferId,
      from: 0,
      to: text.length,
      anchor: insertionAnchor,
      text,
    };
  }

  get(id: string): DraftTextBuffer | undefined {
    return this.buffers.get(id);
  }

  entries(): IterableIterator<[string, DraftTextBuffer]> {
    return this.buffers.entries();
  }

  values(): IterableIterator<DraftTextBuffer> {
    return this.buffers.values();
  }

  assertPiece(piece: InsertedPiece): void {
    const buffer = this.buffers.get(piece.bufferId);
    assert(buffer !== undefined, `missing action-local text buffer ${piece.bufferId}`);
    assert(
      Number.isInteger(piece.from) &&
        Number.isInteger(piece.to) &&
        piece.from >= 0 &&
        piece.to >= piece.from &&
        piece.to <= buffer.text.length,
      `action-local text slice is outside ${piece.bufferId}`,
    );
    assert(
      piece.text === buffer.text.slice(piece.from, piece.to),
      `action-local text slice diverged from ${piece.bufferId}`,
    );
  }

  snapshot(): ReadonlyMap<string, DraftTextBuffer> {
    return new Map(
      [...this.buffers].map(([id, buffer]) => [
        id,
        Object.freeze({
          ...buffer,
          anchor: Object.freeze({ ...buffer.anchor }),
        }),
      ]),
    );
  }

  hasTextAt(tapeId: TapeId): boolean {
    for (const buffer of this.buffers.values()) {
      if (buffer.anchor.tapeId === tapeId && buffer.text.length > 0) return true;
    }
    return false;
  }
}
