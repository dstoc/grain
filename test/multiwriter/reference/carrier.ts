import * as Y from 'yjs';

function uint(value: number): number[] {
  const bytes: number[] = [];
  while (value > 127) {
    bytes.push((value & 127) | 128);
    value = Math.floor(value / 128);
  }
  bytes.push(value);
  return bytes;
}

/** Split original outer items at envelope boundaries, retaining their client/clock,
 * origins, parent and exact payload. Missing prefixes remain missing. This is fault
 * scheduling of original carrier structs, never a new carrier for selected facts.
 */
export function selectCarrier(
  update: Uint8Array,
  include: (bytes: Uint8Array) => boolean,
): Uint8Array {
  const packets: Uint8Array[] = [];
  const decoded = Y.decodeUpdate(update);
  if (decoded.ds.clients.size) throw new Error('Reference carrier must be append-only');
  for (const struct of decoded.structs) {
    if (struct instanceof Y.Skip) continue;
    if (
      !(struct instanceof Y.Item) ||
      (!(struct.content instanceof Y.ContentAny) && !(struct.content instanceof Y.ContentBinary))
    )
      throw new Error('Unexpected canonical carrier struct');
    for (const [offset, value] of (struct.content instanceof Y.ContentAny
      ? struct.content.arr
      : [struct.content.content]
    ).entries()) {
      if (!(value instanceof Uint8Array)) throw new Error('Unexpected canonical payload');
      if (!include(value)) continue;
      const item = new Y.Item(
        Y.createID(struct.id.client, struct.id.clock + offset),
        null,
        offset ? Y.createID(struct.id.client, struct.id.clock + offset - 1) : struct.origin,
        null,
        struct.rightOrigin,
        struct.parent,
        struct.parentSub,
        struct.content instanceof Y.ContentBinary
          ? new Y.ContentBinary(value)
          : new Y.ContentAny([value]),
      );
      const encoder = new Y.UpdateEncoderV1();
      item.write(encoder, 0);
      packets.push(
        Uint8Array.from([
          ...uint(1),
          ...uint(1),
          ...uint(item.id.client),
          ...uint(item.id.clock),
          ...encoder.toUint8Array(),
          0,
        ]),
      );
    }
  }
  return packets.length ? Y.mergeUpdates(packets) : Uint8Array.of(0, 0);
}
