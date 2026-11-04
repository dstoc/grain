import { IngestDataError } from './work.js';
import type { Work } from './work.js';

/** Establish UTF-8 validity without interpreting an unexpected decoder exception as bad data. */
export function* scanUtf8(bytes: Uint8Array, stage: 'carrier' | 'envelope' | 'native'): Work<void> {
  let nextCharge = 0;
  const fail = (): never => {
    throw new IngestDataError(stage, 'utf8', 'Invalid UTF-8');
  };
  for (let index = 0; index < bytes.length;) {
    if (index >= nextCharge) {
      yield;
      nextCharge = index + 1024;
    }
    const first = bytes[index++];
    if (first < 0x80) continue;
    const count =
      first >= 0xc2 && first <= 0xdf
        ? 1
        : first >= 0xe0 && first <= 0xef
          ? 2
          : first >= 0xf0 && first <= 0xf4
            ? 3
            : fail();
    if (count > bytes.length - index) fail();
    const second = bytes[index];
    if (
      (first === 0xe0 && second < 0xa0) ||
      (first === 0xed && second >= 0xa0) ||
      (first === 0xf0 && second < 0x90) ||
      (first === 0xf4 && second >= 0x90)
    )
      fail();
    for (let n = 0; n < count; n++) {
      const byte = bytes[index++];
      if (byte < 0x80 || byte > 0xbf) fail();
    }
  }
}
