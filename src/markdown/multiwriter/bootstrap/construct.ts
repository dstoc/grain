import { parseBlocks } from '../../block-parser/api.js';
import type { MarkdownNode } from '../../node.js';
import { isWellFormed } from '../actions/cbor.js';
import type { Allocation, NodeId, ResourceId, ResourceKind } from '../contracts.js';
import type { BirthPlacement } from '../layout/index.js';
import type { ReferenceGenesis } from '../reference/document.js';
import { NativeTapeCache } from '../text/cache.js';
import type { NativeInsertion } from '../text/types.js';

export function constructGenesis(
  documentId: string,
  source: string,
  nativeOperations: number,
): ReferenceGenesis {
  if (!documentId || !isWellFormed(documentId) || !isWellFormed(source))
    throw new Error('Document ID and Markdown must be valid Unicode');
  const parsed = parseBlocks(source).node;
  const genesisId = crypto.randomUUID();
  let ordinal = 0;
  const id = <K extends ResourceKind>(kind: K): ResourceId<K> => ({
    kind,
    ordinal: ordinal++,
    birth: { type: 'genesis', genesisId },
  });
  const allocations: Allocation[] = [],
    births: BirthPlacement[] = [],
    operations: NativeInsertion[] = [];
  const properties: NonNullable<ReferenceGenesis['initialProperties']>[number][] = [];
  function visit(
    node: MarkdownNode,
    parent: NodeId | null,
    predecessor: BirthPlacement['occurrence'] | null,
  ) {
    const nodeId = id('node');
    const inline = ['paragraph', 'section', 'code-block'].includes(node.type);
    const flow = inline ? id('flow') : null;
    const slot = parent ? { parent, predecessor } : null;
    const role =
      node.type === 'document'
        ? 'root'
        : node.type === 'block-quote'
          ? 'quote'
          : inline
            ? 'inline'
            : node.type === 'list' || node.type === 'list-item'
              ? node.type
              : unsupported(node);
    allocations.push({ type: 'node', id: nodeId, role, flow, birthSlot: slot });
    const occurrence = slot ? id('occurrence') : null;
    if (occurrence && slot) {
      allocations.push({ type: 'occurrence', id: occurrence, slot });
      births.push({ node: nodeId, occurrence });
    }
    const values: NonNullable<ReferenceGenesis['initialProperties']>[number]['values'] = {};
    if ('marker' in node) Object.assign(values, { marker: node.marker });
    if ('checked' in node) Object.assign(values, { checked: node.checked });
    if ('info' in node) Object.assign(values, { info: node.info });
    if (flow && 'content' in node) {
      Object.assign(values, { presentation: node.type === 'code-block' ? 'code' : node.type });
      const run = id('run'),
        tape = id('tape'),
        start = id('marker'),
        end = id('marker');
      operations.push({ type: 'createTape', tape, start, end });
      if (node.content) {
        operations.push({
          type: 'marker',
          tape,
          index: 1,
          marker: id('marker'),
          affinity: 'left',
        });
        operations.push({ type: 'text', tape, index: 2, text: node.content });
        operations.push({
          type: 'marker',
          tape,
          index: node.content.length + 2,
          marker: id('marker'),
          affinity: 'right',
        });
      }
      allocations.push(
        { type: 'flow', id: flow, home: nodeId },
        { type: 'run', id: run, flow, skeleton: [{ tape, start, end }] },
      );
    }
    if (Object.keys(values).length) properties.push({ node: nodeId, values });
    let previous: BirthPlacement['occurrence'] | null = null;
    for (const child of node.children ?? []) previous = visit(child, nodeId, previous);
    return occurrence;
  }
  visit(parsed, null, null);
  const native = new NativeTapeCache(nativeOperations);
  try {
    const prepared = native.prepare('genesis', operations);
    prepared.commit();
    allocations.push(...prepared.body.allocations);
    return {
      documentId,
      genesisId,
      layout: { allocations, births },
      body: { ...prepared.body, allocations },
      initialProperties: properties,
    };
  } finally {
    native.destroy();
  }
}
function unsupported(node: MarkdownNode): never {
  throw new Error(`Unsupported parsed node: ${String(node)}`);
}
