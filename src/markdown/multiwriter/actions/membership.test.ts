import { expect, test } from 'vitest';
import { decodeCbor, encodeCbor, compareBytes } from './cbor.js';
import type { CborValue } from './cbor.js';
import { encodeEnvelope, decodeEnvelope } from './codec.js';
import { fullEnvelope, resource } from './test-fixtures.js';
import type { ActionEnvelope, InterpretationPacket } from '../contracts.js';

function packet(action: ActionEnvelope) {
  const effect = action.effects.find((e) => e.type === 'Interpret');
  if (effect?.type !== 'Interpret') throw new Error();
  return effect.packet;
}
function withFields(fields: Partial<InterpretationPacket>) {
  const action = fullEnvelope();
  return {
    ...action,
    effects: action.effects.map((e) =>
      e.type === 'Interpret' ? { ...e, packet: { ...e.packet, ...fields } } : e,
    ),
  };
}
test('absent membership stays absent and logical empty lists preserve canonical bytes', async () => {
  const old = encodeEnvelope(fullEnvelope()),
    decoded = decodeEnvelope(old);
  // Generated with the unmodified codec at 4fed8f5 (8,470 bytes).
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(old));
  expect(Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')).toBe(
    '6762b9c5403daaf3377aaeb0d2a3971af7cdfeaa3722bbc9e085721e26375302',
  );
  for (const field of ['derivedInlineOutputs', 'effectOrdinals'])
    expect(Object.hasOwn(packet(decoded), field)).toBe(false);
  expect(compareBytes(encodeEnvelope(decoded), old)).toBe(0);
  expect(
    compareBytes(encodeEnvelope(withFields({ derivedInlineOutputs: [], effectOrdinals: [] })), old),
  ).toBe(0);
});
test.each([
  { effectOrdinals: [8, 9] },
  { derivedInlineOutputs: [resource('node', 10, fullEnvelope().id)] },
  { effectOrdinals: [8], derivedInlineOutputs: [resource('node', 10, fullEnvelope().id)] },
])('nonempty membership preserves exact own fields case %#', (fields) => {
  const action = withFields(fields),
    bytes = encodeEnvelope(action);
  expect(packet(decodeEnvelope(bytes))).toEqual(packet(action));
  expect(compareBytes(encodeEnvelope(decodeEnvelope(bytes)), bytes)).toBe(0);
});
test.each(['derivedInlineOutputs', 'effectOrdinals'])(
  'rejects present-empty, null, wrong type and unordered wire %s',
  (field) => {
    for (const value of [[], null, false, 'bad']) {
      const wire = decodeCbor(encodeEnvelope(fullEnvelope())) as Record<string, CborValue>;
      const effects = wire.effects as Record<string, CborValue>[];
      const p = effects.find((e) => e.type === 'Interpret')!.packet as Record<string, CborValue>;
      p[field] = value;
      expect(() => decodeEnvelope(encodeCbor(wire))).toThrow();
    }
    const nodes = [
      resource('node', 11, fullEnvelope().id),
      resource('node', 10, fullEnvelope().id),
    ];
    for (const list of field === 'effectOrdinals'
      ? [[9, 8], [8, 8], [-1], [1.5], [Number.MAX_SAFE_INTEGER + 1]]
      : [nodes, [nodes[0], nodes[0]]]) {
      expect(() => encodeEnvelope(withFields({ [field]: list }))).toThrow();
    }
  },
);
