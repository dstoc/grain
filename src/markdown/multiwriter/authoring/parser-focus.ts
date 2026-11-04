import type { Affinity } from '../contracts.js';
import { resourceKey } from '../layout/index.js';
import type { PreparedOutput, SourceFragment } from '../projection/parser-plan.js';

/** Maps a raw parser caret through exact retained identities and synthesized pieces. */
export function convertedOffset(
  source: readonly SourceFragment[],
  output: PreparedOutput,
): (offset: number, affinity: Affinity) => number {
  const segments: { from: number; to: number; outputFrom: number; outputTo: number }[] = [];
  let outputOffset = 0;
  for (const piece of output.pieces) {
    if (piece.type === 'synthesize') {
      outputOffset += piece.text.length;
      continue;
    }
    for (const range of piece.ranges) {
      let sourceOffset = 0;
      let found = false;
      for (const fragment of source) {
        if (
          resourceKey(fragment.range.tape) === resourceKey(range.tape) &&
          fragment.range.client === range.client &&
          fragment.range.clock <= range.clock &&
          range.clock + range.length <= fragment.range.clock + fragment.range.length
        ) {
          const from = sourceOffset + range.clock - fragment.range.clock;
          segments.push({
            from,
            to: from + range.length,
            outputFrom: outputOffset,
            outputTo: outputOffset + range.length,
          });
          found = true;
          break;
        }
        sourceOffset += fragment.text.length;
      }
      if (!found) throw new Error('Converted focus has no retained source identity');
      outputOffset += range.length;
    }
  }
  return (offset, affinity) => {
    const left = segments.findLast((s) => s.from < offset && offset <= s.to);
    const right = segments.find((s) => s.from <= offset && offset < s.to);
    const previous = segments.filter((s) => s.to < offset).at(-1);
    const next = segments.find((s) => s.from > offset);
    const segment =
      affinity === 'left'
        ? (left ?? right ?? previous ?? next)
        : (right ?? left ?? next ?? previous);
    if (!segment) return offset === 0 ? 0 : outputOffset;
    return Math.max(
      segment.outputFrom,
      Math.min(segment.outputTo, segment.outputFrom + offset - segment.from),
    );
  };
}
