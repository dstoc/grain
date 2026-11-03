import { signal } from '../signals.js';
import type { Signal } from '../signals.js';
import { parser as inlineParser } from './inline-parser.js';
import type { InlineTree } from './inline-parser.js';
import { createSyntaxNode, createTree } from './parser-tree.js';
import type { InlineTreeNode } from './inline-parser.js';
import type { ReadonlyMarkdownNodeView } from './node-view.js';
import type { ConstructionNode, ConstructionTree } from './semantic/construction-tree.js';
import type { NodeId } from './semantic/types.js';

interface PreviewFacade extends ReadonlyMarkdownNodeView {
  readonly renderSignal: Signal<number>;
}

interface InlineCache {
  readonly type: ConstructionNode['type'];
  readonly content: string;
  readonly tree: InlineTree;
}

const inlineCaches = new WeakMap<PreviewFacade, InlineCache>();

/** Renderer-owned, read-only projection for a live parser construction tree. */
export class ConstructionPreviewAdapter {
  private readonly facades = new Map<NodeId, PreviewFacade>();
  private readonly numericIds = new Map<NodeId, number>();
  private nextNumericId = 0;

  constructor(readonly tree: ConstructionTree) {
    tree.takeChanges();
  }

  get root(): ReadonlyMarkdownNodeView {
    return this.facade(this.tree.rootId);
  }

  /** Publishes construction changes through stable renderer facades. */
  refresh(): ReadonlyMarkdownNodeView {
    for (const id of this.tree.takeChanges()) {
      const facade = this.facades.get(id);
      if (facade) facade.renderSignal.value++;
    }
    return this.root;
  }

  private facade(id: NodeId): PreviewFacade {
    const existing = this.facades.get(id);
    if (existing) return existing;
    const renderSignal = signal(0);
    const facade = Object.defineProperties(
      { id: this.numericId(id), renderSignal },
      {
        type: { enumerable: true, get: () => this.record(id).type },
        children: {
          enumerable: true,
          get: () => Object.freeze(this.record(id).children.map((child) => this.facade(child.id))),
        },
        parent: {
          enumerable: true,
          get: () => this.record(id).parent && this.facade(this.record(id).parent!.id),
        },
        previousSibling: {
          enumerable: true,
          get: () =>
            this.record(id).previousSibling && this.facade(this.record(id).previousSibling!.id),
        },
        nextSibling: {
          enumerable: true,
          get: () => this.record(id).nextSibling && this.facade(this.record(id).nextSibling!.id),
        },
        content: { enumerable: true, get: () => inlineContent(this.record(id)) },
        marker: {
          enumerable: true,
          get: () => {
            const node = this.record(id);
            return node.type === 'section' ||
              node.type === 'list-item' ||
              node.type === 'block-quote'
              ? node.marker
              : undefined;
          },
        },
        checked: {
          enumerable: true,
          get: () => {
            const node = this.record(id);
            return node.type === 'list-item' ? node.checked : undefined;
          },
        },
        info: {
          enumerable: true,
          get: () => {
            const node = this.record(id);
            return node.type === 'code-block' ? node.info : undefined;
          },
        },
        connected: { enumerable: true, get: () => this.isConnected(id) },
        version: { enumerable: true, get: () => renderSignal.value },
        inlineTree: { enumerable: true, get: () => this.inlineTree(facade) },
      },
    ) as PreviewFacade;
    Object.freeze(facade);
    this.facades.set(id, facade);
    return facade;
  }

  private numericId(id: NodeId): number {
    let numeric = this.numericIds.get(id);
    if (numeric === undefined) {
      numeric = this.nextNumericId++;
      this.numericIds.set(id, numeric);
    }
    return numeric;
  }

  private record(id: NodeId): ConstructionNode {
    return this.tree.node(id);
  }

  private isConnected(id: NodeId): boolean {
    let current: ConstructionNode | undefined = this.record(id);
    while (current && current.id !== this.tree.rootId) current = current.parent;
    return current?.id === this.tree.rootId;
  }

  private inlineTree(facade: PreviewFacade): InlineTree {
    if (!facade.connected)
      throw new Error('cannot read the inline parse tree of a disconnected node');
    if (facade.type !== 'paragraph' && facade.type !== 'section' && facade.type !== 'code-block') {
      throw new Error(`${facade.type} nodes do not have inline parse trees`);
    }
    const content = facade.content ?? '';
    const cached = inlineCaches.get(facade);
    if (cached?.type === facade.type && cached.content === content) return cached.tree;
    const tree =
      facade.type === 'code-block'
        ? createTree(createSyntaxNode('text', content) as InlineTreeNode)
        : inlineParser.parse(content);
    inlineCaches.set(facade, { type: facade.type, content, tree });
    return tree;
  }
}

function inlineContent(node: ConstructionNode): string | undefined {
  return node.type === 'paragraph' || node.type === 'section' || node.type === 'code-block'
    ? node.content
    : undefined;
}
