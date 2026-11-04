import type { Affinity, NodeId } from '../contracts.js';
import { resourceKey } from '../layout/index.js';
import type { PreparedOutput, SourceFragment } from '../projection/parser-plan.js';

/** Maps a raw parser caret through exact retained identities and synthesized pieces. */
export function convertedFocus(
  source: readonly SourceFragment[],
  outputs: readonly PreparedOutput[],
): (offset: number, affinity: Affinity) => { node: NodeId; offset: number } {
  const segments: {
    from: number;
    to: number;
    outputFrom: number;
    outputTo: number;
    node: NodeId;
  }[] = [];
  const lengths = new Map<PreparedOutput, number>();
  for (const output of outputs) {
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
              node: output.binding.node,
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
    lengths.set(output, outputOffset);
  }
  segments.sort((a, b) => a.from - b.from || a.to - b.to);
  return (offset, affinity) => {
    const left = segments.findLast((s) => s.from < offset && offset <= s.to);
    const right = segments.find((s) => s.from <= offset && offset < s.to);
    const previous = segments.filter((s) => s.to < offset).at(-1);
    const next = segments.find((s) => s.from > offset);
    const segment =
      affinity === 'left'
        ? (left ?? right ?? previous ?? next)
        : (right ?? left ?? next ?? previous);
    if (!segment) {
      const output = offset === 0 ? outputs[0] : outputs.at(-1)!;
      return { node: output.binding.node, offset: offset === 0 ? 0 : lengths.get(output)! };
    }
    return {
      node: segment.node,
      offset: Math.max(
        segment.outputFrom,
        Math.min(segment.outputTo, segment.outputFrom + offset - segment.from),
      ),
    };
  };
}
