import { batch, signal } from '@preact/signals-core';
import { parser, type InlineTree, type InlineTreeNode } from '../../inline-parser.js';
import { createSyntaxNode, createTree } from '../../parser-tree.js';
import type { ReadonlyMarkdownNodeView } from '../../node-view.js';
import type { NodeId } from '../contracts.js';
import { resourceKey } from '../layout/index.js';
import type { ProjectionView, ViewNode } from '../projection/types.js';

/** Local renderer identity. It never enters canonical facts or command envelopes. */
export class ReplicaNodeView implements ReadonlyMarkdownNodeView {
  type: ReadonlyMarkdownNodeView['type'] = 'document';
  children: ReplicaNodeView[] = [];
  parent?: ReplicaNodeView;
  previousSibling?: ReplicaNodeView;
  nextSibling?: ReplicaNodeView;
  content?: string;
  marker?: string;
  checked?: boolean;
  info?: string | null;
  connected = false;
  version = 0;
  readonly renderSignal = signal(0);
  /** Absent only for the local empty-root caret. */
  projection?: ViewNode;
  private parsed?: { content: string; type: string; tree: InlineTree };
  constructor(readonly id: number) {}
  get inlineTree(): InlineTree {
    const content = this.content ?? '';
    if (this.parsed?.content === content && this.parsed.type === this.type) return this.parsed.tree;
    const tree =
      this.type === 'code-block'
        ? createTree(createSyntaxNode('text', content) as InlineTreeNode)
        : parser.parse(content);
    this.parsed = { content, type: this.type, tree };
    return tree;
  }
}
/** Origin-keyed projection of a complete publication; no shared model is changed. */
export class ReplicaRenderTree {
  private readonly cache = new Map<string, ReplicaNodeView>();
  private aliases = new Map<string, ReplicaNodeView>();
  private readonly signatures = new WeakMap<ReplicaNodeView, string>();
  private sequence = 0;
  readonly emptyCaret = new ReplicaNodeView(this.sequence++);
  private root?: ReplicaNodeView;
  constructor() {
    this.emptyCaret.type = 'paragraph';
    this.emptyCaret.content = '';
  }
  node(id: NodeId): ReplicaNodeView | undefined {
    return this.aliases.get(resourceKey(id));
  }
  owns(node: ReadonlyMarkdownNodeView): node is ReplicaNodeView {
    return (
      node instanceof ReplicaNodeView &&
      node.connected &&
      (node === this.emptyCaret ||
        (!!node.projection && this.node(node.projection.origin.representative) === node))
    );
  }
  refresh(view: ProjectionView): ReplicaNodeView {
    const seen = new Set<ReplicaNodeView>();
    const aliases = new Map<string, ReplicaNodeView>();
    const visit = (node: ViewNode, parent?: ReplicaNodeView): ReplicaNodeView => {
      const key = resourceKey(node.origin.representative);
      let facade = this.cache.get(key);
      if (!facade) this.cache.set(key, (facade = new ReplicaNodeView(this.sequence++)));
      for (const constituent of node.origin.constituents)
        aliases.set(resourceKey(constituent), facade);
      seen.add(facade);
      facade.projection = node;
      facade.type = node.type;
      facade.parent = parent;
      facade.connected = true;
      facade.content = ['paragraph', 'section', 'code-block'].includes(node.type)
        ? node.content
        : undefined;
      facade.marker = node.marker ?? undefined;
      facade.checked = node.checked ?? undefined;
      facade.info = node.type === 'code-block' ? node.info : undefined;
      facade.children = node.children.map((child) => visit(child, facade));
      this.link(facade);
      return facade;
    };
    batch(() => {
      this.root = visit(view.root);
      if (view.emptyRoot) {
        seen.add(this.emptyCaret);
        this.emptyCaret.connected = true;
        this.emptyCaret.parent = this.root;
        this.root.children = [this.emptyCaret];
        this.link(this.root);
      }
      this.aliases = aliases;
      for (const node of [...this.cache.values(), this.emptyCaret]) {
        if (!seen.has(node)) {
          node.connected = false;
          node.parent = node.previousSibling = node.nextSibling = undefined;
        }
        const signature = JSON.stringify(
          [
            node.type,
            node.content,
            node.marker,
            node.checked,
            node.info,
            node.children.map((child) => child.id),
            node.connected,
            node.projection?.origin,
            node.projection?.fragments,
            node.projection?.boundaries,
          ],
          (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
        );
        if (this.signatures.get(node) !== signature) {
          this.signatures.set(node, signature);
          node.version++;
          node.renderSignal.value++;
        }
      }
    });
    return this.root!;
  }
  private link(parent: ReplicaNodeView) {
    parent.children.forEach((node, i) => {
      node.previousSibling = parent.children[i - 1];
      node.nextSibling = parent.children[i + 1];
    });
  }
}
