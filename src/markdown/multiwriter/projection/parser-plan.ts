import { isInlineNode } from '../../node.js';
import type { MarkdownNode } from '../../node.js';
import type { ParserConversionPlan } from '../../block-parser/types.js';
import {
  assertTextRange as checkTextRange,
  assertWellFormedText as checkWellFormedText,
} from '../../semantic/types.js';
import type {
  ActionEnvelope,
  Allocation,
  BlockSlot,
  FlowId,
  InterpretationId,
  InterpretationPacket,
  NativeTextRange,
  NodeId,
  OccurrenceId,
  RunId,
} from '../contracts.js';
import { allowsRawChild, resourceKey } from '../layout/index.js';
import { sameSlot } from '../layout/occurrences.js';
import { exactContains, ProjectionError } from './interpretation.js';
import { NativeValidationError } from '../text/identity.js';
import type { PresentedProperties } from './interpretation.js';

/** Ordered native fragments of the exact author-visible parser input. */
export interface SourceFragment {
  readonly text: string;
  readonly range: NativeTextRange;
}
export interface OutputBinding {
  readonly key: string;
  readonly node: NodeId;
  readonly flow?: FlowId;
  readonly run?: RunId;
  readonly occurrence: OccurrenceId;
  readonly slot: BlockSlot;
}
export type PreparedPiece =
  | { readonly type: 'retain'; readonly ranges: readonly NativeTextRange[]; readonly text: string }
  | { readonly type: 'synthesize'; readonly request: string; readonly text: string };
export interface PreparedOutput {
  readonly binding: OutputBinding;
  readonly type: MarkdownNode['type'];
  readonly properties: PresentedProperties;
  readonly pieces: readonly PreparedPiece[];
}
export interface PreparedConversion {
  readonly source: NodeId;
  readonly outputs: readonly PreparedOutput[];
  readonly syntaxMask: readonly NativeTextRange[];
  readonly synthesis: readonly { readonly request: string; readonly text: string }[];
}

/** No allocation, publication or structural lowering. Invalid optional conversions can stay literal. */
export function prepareParserConversion(input: {
  readonly source: NodeId;
  readonly text: string;
  readonly fragments: readonly SourceFragment[];
  readonly plan: ParserConversionPlan;
  readonly bindings: readonly OutputBinding[];
}): PreparedConversion {
  return prepare(input);
}
// Only input-validation failures become a declined conversion. Unexpected errors
// in supplied plans or host code must retain their operational meaning.
function assertTextRange(...args: Parameters<typeof checkTextRange>): void {
  try {
    checkTextRange(...args);
  } catch (error) {
    if (error instanceof Error) throw new ProjectionError(error.message);
    throw error;
  }
}
function assertWellFormedText(...args: Parameters<typeof checkWellFormedText>): void {
  try {
    checkWellFormedText(...args);
  } catch (error) {
    if (error instanceof Error) throw new ProjectionError(error.message);
    throw error;
  }
}
function prepare(input: Parameters<typeof prepareParserConversion>[0]): PreparedConversion {
  const { text, plan } = input;
  assertWellFormedText(text);
  let offset = 0;
  const fragments = input.fragments.map((fragment) => {
    assertWellFormedText(fragment.text);
    if (!fragment.text.length || fragment.text.length !== fragment.range.length)
      throw new ProjectionError('Source fragment length mismatch');
    const from = offset;
    offset += fragment.text.length;
    return { ...fragment, from, to: offset };
  });
  if (fragments.map((fragment) => fragment.text).join('') !== text)
    throw new ProjectionError('Source fragments do not reconstruct parser input');
  // A source identity cannot appear twice, even under different parser offsets.
  for (const [i, left] of fragments.entries())
    for (const right of fragments.slice(i + 1))
      if (
        resourceKey(left.range.tape) === resourceKey(right.range.tape) &&
        left.range.client === right.range.client &&
        Math.max(left.range.clock, right.range.clock) <
          Math.min(left.range.clock + left.range.length, right.range.clock + right.range.length)
      )
        throw new ProjectionError('Repeated source identity');
  function ranges(from: number, to: number): NativeTextRange[] {
    assertTextRange(text, from, to, 'Parser source range');
    if (from === to) throw new ProjectionError('Empty parser source range');
    return fragments.flatMap((fragment) => {
      const start = Math.max(from, fragment.from);
      const end = Math.min(to, fragment.to);
      return start < end
        ? [
            {
              ...fragment.range,
              clock: fragment.range.clock + start - fragment.from,
              length: end - start,
            },
          ]
        : [];
    });
  }
  const nodes = new Map<string, MarkdownNode>();
  function visit(node: MarkdownNode, path: number[]): void {
    if (node.type !== 'document') nodes.set(path.join('.') || 'root', node);
    for (const [i, child] of (node.children ?? []).entries()) visit(child, [...path, i]);
  }
  visit(plan.output, []);
  const bindings = new Map(input.bindings.map((binding) => [binding.key, binding]));
  if (
    bindings.size !== input.bindings.length ||
    bindings.size !== nodes.size ||
    [...bindings.keys()].some((key) => !nodes.has(key))
  )
    throw new ProjectionError('Output bindings must cover exactly the parsed nodes');
  if (new Set(input.bindings.map((binding) => resourceKey(binding.node))).size !== bindings.size)
    throw new ProjectionError('Output node bindings must be distinct');
  for (const [key] of nodes) {
    const parentKey = key.includes('.') ? key.slice(0, key.lastIndexOf('.')) : null;
    if (
      parentKey &&
      bindings.has(parentKey) &&
      resourceKey(bindings.get(key)!.slot.parent) !== resourceKey(bindings.get(parentKey)!.node)
    )
      throw new ProjectionError('Output binding parent disagrees with parsed hierarchy');
  }
  const inlineKeys = [...nodes].filter(([, node]) => isInlineNode(node)).map(([key]) => key);
  if (
    Object.keys(plan.inlinePieces).length !== inlineKeys.length ||
    Object.keys(plan.inlinePieces).some((key) => !inlineKeys.includes(key))
  )
    throw new ProjectionError('Inline piece paths do not match output');
  const retained: { from: number; to: number }[] = [];
  const synthesis: { request: string; text: string }[] = [];
  const outputs: PreparedOutput[] = [];
  for (const [key, node] of nodes) {
    const binding = bindings.get(key)!;
    const pieces: PreparedPiece[] = [];
    if (isInlineNode(node)) {
      if (!binding.flow || !binding.run)
        throw new ProjectionError('Inline output needs a stable flow and run');
      const parserPieces = plan.inlinePieces[key];
      if (!parserPieces) throw new ProjectionError('Missing inline pieces');
      for (const [i, piece] of parserPieces.entries()) {
        if (piece.kind === 'retain') {
          const mapped = ranges(piece.sourceFrom, piece.sourceTo);
          retained.push({ from: piece.sourceFrom, to: piece.sourceTo });
          pieces.push({
            type: 'retain',
            ranges: mapped,
            text: text.slice(piece.sourceFrom, piece.sourceTo),
          });
        } else {
          assertWellFormedText(piece.text);
          if (!piece.text.length) throw new ProjectionError('Empty synthesis request');
          const request = `${key}:${i}`;
          synthesis.push({ request, text: piece.text });
          pieces.push({ type: 'synthesize', request, text: piece.text });
        }
      }
      if (pieces.map((piece) => piece.text).join('') !== node.content)
        throw new ProjectionError('Pieces do not reconstruct parsed output');
    } else if (binding.flow || binding.run)
      throw new ProjectionError('Wrapper output cannot own an inline flow');
    const properties: PresentedProperties = {
      presentation:
        node.type === 'section' ? 'section' : node.type === 'code-block' ? 'code' : 'paragraph',
      marker: 'marker' in node ? node.marker : null,
      info: node.type === 'code-block' ? node.info : null,
      checked: node.type === 'list-item' ? (node.checked ?? null) : null,
    };
    outputs.push({ binding, type: node.type, properties, pieces });
  }
  if (
    !inlineKeys.length ||
    resourceKey(bindings.get(inlineKeys[0]!)!.node) !== resourceKey(input.source)
  )
    throw new ProjectionError('Conversion must bind its stable source');
  retained.sort((a, b) => a.from - b.from || a.to - b.to);
  let cursor = 0;
  const consumed: { from: number; to: number }[] = [];
  for (const range of retained) {
    if (range.from < cursor) throw new ProjectionError('Duplicate retained source ownership');
    if (range.from > cursor) consumed.push({ from: cursor, to: range.from });
    cursor = range.to;
  }
  if (cursor < text.length) consumed.push({ from: cursor, to: text.length });
  if (
    consumed.length !== plan.consumed.length ||
    consumed.some(
      (range, i) => range.from !== plan.consumed[i]?.from || range.to !== plan.consumed[i]?.to,
    )
  )
    throw new ProjectionError('Consumed ranges do not classify all non-retained source');
  return structuredClone({
    source: input.source,
    outputs,
    syntaxMask: consumed.flatMap(({ from, to }) => ranges(from, to)),
    synthesis,
  });
}

export interface BoundConversion {
  readonly packet: InterpretationPacket;
  /** MW-09 lowers these exact identities and bindings into split/transfer/property effects. */
  readonly outputs: readonly {
    readonly output: PreparedOutput;
    readonly ranges: readonly NativeTextRange[];
  }[];
}

/** Bind author-allocated native synthesis. The caller still owns publication and history. */
export function bindParserConversion(
  prepared: PreparedConversion,
  id: InterpretationId,
  action: ActionEnvelope,
  bindings: readonly { readonly request: string; readonly ranges: readonly NativeTextRange[] }[],
  read: (range: NativeTextRange) => string,
  retained: readonly Allocation[],
): BoundConversion {
  const nativeText = (range: NativeTextRange) => {
    try {
      return read(range);
    } catch (error) {
      if (error instanceof NativeValidationError) throw new ProjectionError(error.message);
      throw error;
    }
  };
  const byRequest = new Map(bindings.map((binding) => [binding.request, binding.ranges]));
  if (
    byRequest.size !== bindings.length ||
    byRequest.size !== prepared.synthesis.length ||
    prepared.synthesis.some((request) => !byRequest.has(request.request))
  )
    throw new ProjectionError('Incomplete synthesis bindings');
  const sourceRanges = [
    ...prepared.syntaxMask,
    ...prepared.outputs.flatMap((output) =>
      output.pieces.flatMap((piece) => (piece.type === 'retain' ? piece.ranges : [])),
    ),
  ];
  const synthesized: NativeTextRange[] = [];
  for (const request of prepared.synthesis) {
    const ranges = byRequest.get(request.request)!;
    if (!ranges.length || ranges.map(nativeText).join('') !== request.text)
      throw new ProjectionError('Synthesis binding text mismatch');
    for (const range of ranges) {
      if (
        !action.nativeManifest.some(
          (birth) =>
            birth.type === 'text' && exactContains({ tape: birth.tape, ...birth.native }, range),
        )
      )
        throw new ProjectionError('Synthesis must be born in the author action');
      if (
        !action.effects.some(
          (effect) =>
            effect.type === 'InsertText' &&
            effect.ranges.some((inserted) => exactContains(inserted, range)),
        )
      )
        throw new ProjectionError('Synthesis needs an insertion effect');
      if (
        sourceRanges.some(
          (source) =>
            resourceKey(source.tape) === resourceKey(range.tape) &&
            source.client === range.client &&
            Math.max(source.clock, range.clock) <
              Math.min(source.clock + source.length, range.clock + range.length),
        )
      )
        throw new ProjectionError(
          'Synthesis must use fresh identities distinct from parser source',
        );
      if (
        synthesized.some(
          (prior) =>
            resourceKey(prior.tape) === resourceKey(range.tape) &&
            prior.client === range.client &&
            Math.max(prior.clock, range.clock) <
              Math.min(prior.clock + prior.length, range.clock + range.length),
        )
      )
        throw new ProjectionError('Synthesis identity bound twice');
      synthesized.push(range);
    }
  }
  const allocations = new Map(
    action.allocations.map((allocation) => [resourceKey(allocation.id), allocation]),
  );
  if (allocations.get(resourceKey(id))?.type !== 'interpretation')
    throw new ProjectionError('Packet identity must be allocated in author action');
  const all = new Map(
    [...retained, ...action.allocations].map((allocation) => [
      resourceKey(allocation.id),
      allocation,
    ]),
  );
  for (const output of prepared.outputs) {
    const { binding } = output;
    const node = all.get(resourceKey(binding.node));
    const parent = all.get(resourceKey(binding.slot.parent));
    const occurrence = allocations.get(resourceKey(binding.occurrence));
    const role =
      output.type === 'block-quote'
        ? 'quote'
        : ['paragraph', 'section', 'code-block'].includes(output.type)
          ? 'inline'
          : output.type;
    if (
      node?.type !== 'node' ||
      node.role !== role ||
      parent?.type !== 'node' ||
      !allowsRawChild(parent.role, node.role)
    )
      throw new ProjectionError('Output binding disagrees with retained node roles');
    if (occurrence?.type !== 'occurrence' || !sameSlot(occurrence.slot, binding.slot))
      throw new ProjectionError(
        'Output placement requires an author-allocated occurrence at the exact slot',
      );
    if (node.role === 'inline' ? !binding.flow || !binding.run : !!binding.flow || !!binding.run)
      throw new ProjectionError('Incomplete output flow/run binding');
    if (
      resourceKey(binding.node) !== resourceKey(prepared.source) &&
      !allocations.has(resourceKey(binding.node))
    )
      throw new ProjectionError('Additional output nodes must be allocated in the author action');
    const parentKey = binding.key.includes('.')
      ? binding.key.slice(0, binding.key.lastIndexOf('.'))
      : null;
    const parsedParent =
      parentKey && prepared.outputs.find((candidate) => candidate.binding.key === parentKey);
    if (parsedParent && resourceKey(binding.slot.parent) !== resourceKey(parsedParent.binding.node))
      throw new ProjectionError('Final output binding parent disagrees with parsed hierarchy');
    if (binding.flow && binding.run) {
      const flow = all.get(resourceKey(binding.flow));
      const run = all.get(resourceKey(binding.run));
      if (
        !node.flow ||
        resourceKey(node.flow) !== resourceKey(binding.flow) ||
        flow?.type !== 'flow' ||
        resourceKey(flow.home) !== resourceKey(binding.node) ||
        run?.type !== 'run' ||
        resourceKey(run.flow) !== resourceKey(binding.flow)
      )
        throw new ProjectionError('Inline binding disagrees with retained flow/run');
    }
    for (const piece of output.pieces)
      if (piece.type === 'retain' && piece.ranges.map(nativeText).join('') !== piece.text)
        throw new ProjectionError('Retained output identity text mismatch');
  }
  const sourceOutput = prepared.outputs.find(
    (output) => resourceKey(output.binding.node) === resourceKey(prepared.source),
  );
  if (!sourceOutput || !['paragraph', 'section', 'code-block'].includes(sourceOutput.type))
    throw new ProjectionError('Missing inline source output');
  const outputs = prepared.outputs.map((output) => ({
    output,
    ranges: output.pieces.flatMap((piece) =>
      piece.type === 'retain' ? piece.ranges : byRequest.get(piece.request)!,
    ),
  }));
  return structuredClone({
    packet: {
      id,
      source: prepared.source,
      properties: {
        presentation: sourceOutput.properties.presentation,
        marker: sourceOutput.properties.marker,
        info: sourceOutput.properties.info,
      },
      wrappers: prepared.outputs
        .filter((output) => ['list', 'list-item', 'block-quote'].includes(output.type))
        .map((output) => output.binding.node),
      placements: prepared.outputs.map(({ binding }) => ({
        node: binding.node,
        occurrence: binding.occurrence,
        slot: binding.slot,
      })),
      syntaxMask: prepared.syntaxMask,
      synthesizedText: synthesized,
    },
    outputs,
  });
}
