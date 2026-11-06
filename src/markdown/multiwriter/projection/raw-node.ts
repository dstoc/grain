import type { Allocation } from '../contracts.js';
import type { PresentedProperties } from './interpretation.js';
import type { MutableViewNode, ViewNode } from './types.js';

export function projectedNodeType(
  allocation: Extract<Allocation, { type: 'node' }>,
  properties: PresentedProperties,
): ViewNode['type'] {
  return allocation.role === 'root'
    ? 'document'
    : allocation.role === 'quote'
      ? 'block-quote'
      : allocation.role === 'inline'
        ? properties.presentation === 'code'
          ? 'code-block'
          : properties.presentation
        : allocation.role;
}
/** Common raw-node construction; normalization owns grouping and numbering. */
export function rawProjectionNode(
  allocation: Extract<Allocation, { type: 'node' }>,
  properties: PresentedProperties,
  edge: ViewNode['edge'],
): MutableViewNode {
  const type = projectedNodeType(allocation, properties);
  return {
    origin: { type: 'node', representative: allocation.id, constituents: [allocation.id] },
    edge,
    type,
    marker:
      properties.marker ??
      (type === 'section'
        ? '#'
        : type === 'list-item'
          ? '- '
          : type === 'block-quote'
            ? '> '
            : null),
    info: properties.info,
    checked: properties.checked,
    content: '',
    children: [],
    fragments: [],
    boundaries: [],
    wrappers: [],
  };
}
