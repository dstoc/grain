import { signal } from '../../signals.js';
import { createSyntaxNode, createTree } from '../parser-tree.js';
import { parser as inlineParser } from '../inline-parser.js';
import type { InlineTree, InlineTreeNode } from '../inline-parser.js';
import type { Caches } from '../view-model-node.js';
import type { NodeId, NodeKind } from '../semantic/types.js';

const INLINE_KINDS = new Set<NodeKind>(['paragraph', 'section', 'code-block']);
let canonicalProjectionId = 0;

interface InlineProjectionCache {
  readonly type: NodeKind;
  readonly content: string;
  readonly tree: InlineTree;
}

const inlineProjectionCaches = new WeakMap<CanonicalNode, InlineProjectionCache>();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** The narrow read capability used by stable canonical node projections. */
export interface CanonicalNodeProjectionOwner {
  nodeKind(id: NodeId): NodeKind;
  childIds(id: NodeId): readonly NodeId[];
  scalar(id: NodeId, field: 'marker' | 'checked' | 'info'): unknown;
  nodeContent(id: NodeId): string;
  node(id: NodeId): CanonicalNode;
  parentId(id: NodeId): NodeId | undefined;
  sibling(id: NodeId, direction: -1 | 1): CanonicalNode | undefined;
  isConnected(id: NodeId): boolean;
  nodeCaches(id: NodeId): Readonly<Caches> | undefined;
  nodeVersion(id: NodeId): number;
}

/** Stable, read-only node view over a document-owned projection capability. */
export class CanonicalNode {
  readonly renderSignal = signal(0);
  readonly id = canonicalProjectionId++;

  constructor(
    readonly sharedId: NodeId,
    private readonly owner: CanonicalNodeProjectionOwner,
  ) {
    Object.freeze(this);
  }

  get type(): NodeKind {
    return this.owner.nodeKind(this.sharedId);
  }

  get children(): readonly CanonicalNode[] {
    return Object.freeze(this.owner.childIds(this.sharedId).map((id) => this.owner.node(id)));
  }

  get parent(): CanonicalNode | undefined {
    const parentId = this.owner.parentId(this.sharedId);
    return parentId ? this.owner.node(parentId) : undefined;
  }

  get previousSibling(): CanonicalNode | undefined {
    return this.owner.sibling(this.sharedId, -1);
  }

  get nextSibling(): CanonicalNode | undefined {
    return this.owner.sibling(this.sharedId, 1);
  }

  get connected(): boolean {
    return this.owner.isConnected(this.sharedId);
  }

  get version(): number {
    return this.owner.nodeVersion(this.sharedId);
  }

  get caches(): Readonly<Caches> | undefined {
    return this.owner.nodeCaches(this.sharedId);
  }

  get content(): string | undefined {
    if (!INLINE_KINDS.has(this.type)) return undefined;
    return this.owner.nodeContent(this.sharedId);
  }

  get marker(): string | undefined {
    const value = this.owner.scalar(this.sharedId, 'marker');
    return typeof value === 'string' ? value : undefined;
  }

  get checked(): boolean | undefined {
    const value = this.owner.scalar(this.sharedId, 'checked');
    return typeof value === 'boolean' ? value : undefined;
  }

  get info(): string | null | undefined {
    if (this.type !== 'code-block') return undefined;
    return this.owner.scalar(this.sharedId, 'info') as string | null;
  }

  get inlineTree(): InlineTree {
    assert(this.connected, 'cannot read the inline parse tree of a disconnected node');
    const type = this.type;
    assert(INLINE_KINDS.has(type), `${type} nodes do not have inline parse trees`);
    const content = this.content ?? '';
    const cached = inlineProjectionCaches.get(this);
    if (cached?.type === type && cached.content === content) return cached.tree;
    const tree =
      type === 'code-block'
        ? createTree(createSyntaxNode('text', content) as InlineTreeNode)
        : inlineParser.parse(content);
    inlineProjectionCaches.set(this, { type, content, tree });
    return tree;
  }
}
