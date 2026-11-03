import * as Y from 'yjs';

import type { Span } from './types.js';

export function textBetweenBoundaries(tape: Y.Text, span: Span): string {
  let within = false;
  let output = '';
  for (const delta of tape.toDelta()) {
    const insert = delta.insert;
    if (typeof insert === 'string') {
      if (within) output += insert;
      continue;
    }
    const boundary =
      insert !== null && typeof insert === 'object' && 'grainBoundary' in insert
        ? (insert as { readonly grainBoundary?: unknown }).grainBoundary
        : undefined;
    if (boundary === span.startBoundaryId) within = true;
    else if (boundary === span.endBoundaryId) break;
  }
  return output;
}
