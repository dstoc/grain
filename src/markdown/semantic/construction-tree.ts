import type { MarkdownNode, DocumentNode } from '../node.js';
import type { TextPoint } from './selection.js';
import type {
  ConversionPlan,
  DraftNode,
  DraftTextPiece,
  InlineFragment,
  ParserTreeDraft,
  Transfer,
} from './draft.js';
import type { CreateNodeSpec, NodeId, TextAffinity, TextEdit } from './types.js';
import {
  assertTextEdit,
  assertTextPoint,
  assertTextRange,
  assertWellFormedText,
  isAllowedSemanticChild,
} from './types.js';
import { normalizeSemanticTree, type SemanticNormalizeOptions } from './normalize.js';

/** A parser-local plain record. IDs and parent/sibling links never leave a parser instance. */
interface ConstructionNodeLinks {
  readonly id: NodeId;
  children: ConstructionNode[];
  parent?: ConstructionNode;
  previousSibling?: ConstructionNode;
  nextSibling?: ConstructionNode;
}

interface ConstructionTreeStorage {
  readonly records: Map<NodeId, ConstructionNode>;
  readonly views: Map<NodeId, DraftNode>;
  nextId: number;
}

export type ConstructionNode =
  | (ConstructionNodeLinks & { type: 'document' })
  | (ConstructionNodeLinks & { type: 'list' })
  | (ConstructionNodeLinks & { type: 'block-quote'; marker: string })
  | (ConstructionNodeLinks & { type: 'list-item'; marker: string; checked?: boolean })
  | (ConstructionNodeLinks & { type: 'paragraph'; content: string })
  | (ConstructionNodeLinks & { type: 'section'; marker: string; content: string })
  | (ConstructionNodeLinks & { type: 'code-block'; content: string; info: string | null });
export type ConstructionDocumentNode = Extract<ConstructionNode, { type: 'document' }>;

/**
 * The headless mutable tree used while parsing. It stores plain records and
 * exposes all structural edits through the shared semantic draft contract.
 */
export class ConstructionTree {
  readonly draft: ConstructionTreeDraft;
  readonly root: ConstructionDocumentNode;
  readonly rootId: NodeId;
  private revision_ = 0;
  private readonly changedIds = new Set<NodeId>();

  constructor(root: DocumentNode) {
    this.draft = new ConstructionTreeDraft(this);
    this.root = this.draft.adopt(root) as ConstructionDocumentNode;
    this.rootId = this.root.id;
  }

  get revision(): number {
    return this.revision_;
  }

  markChanged(...ids: NodeId[]): void {
    this.revision_++;
    for (const id of ids) this.changedIds.add(id);
  }

  takeChanges(): ReadonlySet<NodeId> {
    const changed = new Set(this.changedIds);
    this.changedIds.clear();
    return changed;
  }

  normalize(options: SemanticNormalizeOptions = {}): void {
    normalizeSemanticTree(this.draft, this.rootId, options);
  }

  createDraft(): ConstructionTreeDraft {
    return this.draft.fork();
  }

  node(id: NodeId): ConstructionNode {
    return this.draft.record(id);
  }

  serialize(node: ConstructionNode = this.root): MarkdownNode {
    const result: Record<string, unknown> = { type: node.type };
    if (node.type === 'paragraph' || node.type === 'section' || node.type === 'code-block') {
      result.content = node.content ?? '';
    }
    if (node.type === 'section' || node.type === 'list-item' || node.type === 'block-quote') {
      result.marker =
        node.marker ?? (node.type === 'section' ? '#' : node.type === 'list-item' ? '- ' : '> ');
    }
    if (node.type === 'list-item' && node.checked !== undefined) result.checked = node.checked;
    if (node.type === 'code-block') result.info = node.info ?? null;
    if (
      node.type === 'document' ||
      node.type === 'section' ||
      node.type === 'list' ||
      node.type === 'list-item' ||
      node.type === 'block-quote'
    ) {
      result.children = node.children.map((child) => this.serialize(child));
    }
    return result as unknown as MarkdownNode;
  }
}

export class ConstructionTreeDraft implements ParserTreeDraft {
  private readonly fragments = new WeakMap<object, { readonly text: string }>();
  private readonly consumedFragments = new WeakSet<object>();

  constructor(
    private readonly tree: ConstructionTree,
    private readonly storage: ConstructionTreeStorage = {
      records: new Map(),
      views: new Map(),
      nextId: 0,
    },
  ) {}

  fork(): ConstructionTreeDraft {
    return new ConstructionTreeDraft(this.tree, this.storage);
  }

  adopt(root: DocumentNode): ConstructionNode {
    const clone = structuredClone(root);
    const visit = (node: MarkdownNode, parent?: ConstructionNode): ConstructionNode => {
      if (node.type === 'paragraph' || node.type === 'section' || node.type === 'code-block') {
        assertWellFormedText(node.content);
      }
      const record = recordFromNode(node, this.allocateId(), parent);
      this.storage.records.set(record.id, record);
      record.children = (node.children ?? []).map((child) => visit(child, record));
      relink(record);
      return record;
    };
    return visit(clone);
  }

  record(id: NodeId): ConstructionNode {
    const record = this.storage.records.get(id);
    expect(record, `unknown construction node ${id}`);
    return record;
  }

  node(id: NodeId): DraftNode {
    const cached = this.storage.views.get(id);
    if (cached) return cached;
    const view = Object.defineProperties(
      { id },
      {
        type: { enumerable: true, get: () => this.record(id).type },
        children: {
          enumerable: true,
          get: () => Object.freeze(this.record(id).children.map((child) => child.id)),
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
              : null;
          },
        },
        checked: {
          enumerable: true,
          get: () => {
            const node = this.record(id);
            return node.type === 'list-item' ? (node.checked ?? null) : null;
          },
        },
        info: {
          enumerable: true,
          get: () => {
            const node = this.record(id);
            return node.type === 'code-block' ? node.info : null;
          },
        },
      },
    ) as DraftNode;
    Object.freeze(view);
    this.storage.views.set(id, view);
    return view;
  }

  parentOf(id: NodeId): NodeId | undefined {
    return this.record(id).parent?.id;
  }

  previousSiblingOf(id: NodeId): NodeId | undefined {
    return this.record(id).previousSibling?.id;
  }

  nextSiblingOf(id: NodeId): NodeId | undefined {
    return this.record(id).nextSibling?.id;
  }

  create(spec: CreateNodeSpec): NodeId {
    const untypedSpec = spec as unknown as {
      readonly type: string;
      readonly children?: readonly NodeId[];
    };
    expect(untypedSpec.type !== 'document', 'a semantic draft cannot create another root');
    expect(
      !untypedSpec.children?.length,
      'create nodes without children, then place each child explicitly',
    );
    if ('content' in spec && spec.content !== undefined) assertWellFormedText(spec.content);
    const record = recordFromSpec(spec, this.allocateId());
    this.storage.records.set(record.id, record);
    this.tree.markChanged(record.id);
    return record.id;
  }

  place(id: NodeId, parentId: NodeId, beforeId: NodeId | null): void {
    expect(id !== this.tree.rootId, 'the document root cannot be placed');
    const node = this.record(id);
    const parent = this.record(parentId);
    const before = beforeId === null ? undefined : this.record(beforeId);
    expect(node !== parent, 'a node cannot be its own parent');
    expect(!isAncestor(node, parent), 'placement would create a cycle');
    expect(
      isAllowedSemanticChild(parent.type, node.type),
      `${node.type} cannot be a child of ${parent.type}`,
    );
    if (before === node) {
      expect(node.parent === parent, 'before must be a child of the destination');
      return;
    }
    expect(
      before === undefined || before.parent === parent,
      'reference node is not a child of parent',
    );
    if (node.parent === parent && node.nextSibling === before) return;
    const oldParent = node.parent;
    unlink(node);
    node.parent = parent;
    const index = before ? parent.children.indexOf(before) : parent.children.length;
    parent.children.splice(index, 0, node);
    relink(parent);
    this.tree.markChanged(node.id, parent.id, ...(oldParent ? [oldParent.id] : []));
  }

  detach(id: NodeId): void {
    expect(id !== this.tree.rootId, 'the document root cannot be detached');
    const node = this.record(id);
    expect(node.parent, `node ${id} is already detached`);
    const parent = node.parent;
    unlink(node);
    this.tree.markChanged(node.id, ...(parent ? [parent.id] : []));
  }

  spliceText(id: NodeId, edit: TextEdit): void {
    const node = this.record(id);
    const content = inlineContent(node);
    expect(content !== undefined, `${node.type} has no inline text`);
    assertTextEdit(content, edit);
    const next = content.slice(0, edit.from) + edit.insert + content.slice(edit.to);
    if (next === content) return;
    (node as { content: string }).content = next;
    this.tree.markChanged(id);
  }

  cutInline(id: NodeId, from: number, to: number): InlineFragment {
    const text = inlineContent(this.record(id));
    expect(text !== undefined, `${this.record(id).type} has no inline text`);
    assertTextRange(text, from, to, 'cut range');
    expect(to > from, 'cut range must contain text');
    const fragment = Object.freeze({ text: text.slice(from, to) }) as InlineFragment;
    this.fragments.set(fragment, fragment);
    this.spliceText(id, { from, to, insert: '' });
    return fragment;
  }

  insertFragment(
    destination: NodeId,
    at: number,
    _affinity: TextAffinity,
    fragment: InlineFragment,
  ): void {
    const owned = this.fragments.get(fragment);
    expect(owned, 'fragment was not created by this construction draft');
    expect(!this.consumedFragments.has(fragment), 'fragment has already been inserted');
    const text = inlineContent(this.record(destination));
    expect(text !== undefined, `${this.record(destination).type} has no inline text`);
    assertTextPoint(text, at, 'fragment target');
    this.spliceText(destination, { from: at, to: at, insert: owned.text });
    this.consumedFragments.add(fragment);
  }

  transferInlineRange(transfer: Transfer): void {
    const sourceText = inlineContent(this.record(transfer.source));
    const targetText = inlineContent(this.record(transfer.destination));
    expect(sourceText !== undefined, `${this.record(transfer.source).type} has no inline text`);
    expect(
      targetText !== undefined,
      `${this.record(transfer.destination).type} has no inline text`,
    );
    assertTextRange(sourceText, transfer.from, transfer.to, 'transfer range');
    expect(transfer.to > transfer.from, 'transfer range must contain text');
    assertTextPoint(targetText, transfer.at, 'transfer destination');
    if (transfer.source === transfer.destination) {
      if (transfer.at === transfer.from || transfer.at === transfer.to) return;
      expect(
        !(transfer.from < transfer.at && transfer.at < transfer.to),
        'same-node destination cannot be inside the transferred range',
      );
    }
    const fragment = this.cutInline(transfer.source, transfer.from, transfer.to);
    const at =
      transfer.source === transfer.destination && transfer.at > transfer.from
        ? Math.max(transfer.from, transfer.at - (transfer.to - transfer.from))
        : transfer.at;
    this.insertFragment(transfer.destination, at, transfer.affinity, fragment);
  }

  convertInline(id: NodeId, plan: ConversionPlan): void {
    const node = this.record(id);
    const current = inlineContent(node);
    expect(current !== undefined, `${node.type} is not an inline node`);
    const content = plan.content?.mode === 'replace' ? plan.content.text : current;
    assertWellFormedText(content);
    const marker = plan.type === 'section' ? (plan.marker ?? '#') : undefined;
    const info = plan.type === 'code-block' ? (plan.info ?? null) : undefined;
    const currentMarker = node.type === 'section' ? node.marker : undefined;
    const currentInfo = node.type === 'code-block' ? node.info : undefined;
    if (
      node.type === plan.type &&
      current === content &&
      currentMarker === marker &&
      currentInfo === info
    )
      return;
    const mutable = node as unknown as ConstructionNodeLinks & {
      type: 'paragraph' | 'section' | 'code-block';
      content: string;
      marker?: string;
      info?: string | null;
    };
    mutable.type = plan.type;
    mutable.content = content;
    if (marker === undefined) delete mutable.marker;
    else mutable.marker = marker;
    if (info === undefined) delete mutable.info;
    else mutable.info = info;
    this.tree.markChanged(id);
  }

  setMarker(id: NodeId, marker: string | null): void {
    const node = this.record(id);
    expect(node.type === 'section' || node.type === 'list-item', `${node.type} has no marker`);
    expect(marker !== null, 'Markdown section and list-item markers cannot be null');
    if (node.marker === marker) return;
    node.marker = marker;
    this.tree.markChanged(id);
  }

  setChecked(id: NodeId, checked: boolean | null): void {
    const node = this.record(id);
    expect(node.type === 'list-item', `${node.type} has no checked state`);
    const value = checked ?? undefined;
    if (node.checked === value) return;
    if (value === undefined) delete node.checked;
    else node.checked = value;
    this.tree.markChanged(id);
  }

  setInfo(id: NodeId, info: string | null): void {
    const node = this.record(id);
    expect(node.type === 'code-block', `${node.type} has no code info`);
    if (node.info === info) return;
    node.info = info;
    this.tree.markChanged(id);
  }

  bookmark(id: NodeId, offset: number, affinity: TextAffinity): TextPoint {
    const text = inlineContent(this.record(id));
    expect(text !== undefined, `${this.record(id).type} has no text bookmarks`);
    assertTextPoint(text, offset, 'bookmark offset');
    return Object.freeze({ nodeId: id, offset, affinity });
  }

  sourcePieces(id: NodeId): readonly DraftTextPiece[] {
    const text = inlineContent(this.record(id));
    expect(text !== undefined, `${this.record(id).type} has no source text`);
    return text.length ? [{ from: 0, to: text.length, kind: 'existing' }] : [];
  }

  private allocateId(): NodeId {
    return `construction:${this.storage.nextId++}`;
  }
}

function recordFromNode(
  node: MarkdownNode,
  id: NodeId,
  parent?: ConstructionNode,
): ConstructionNode {
  const links = { id, children: [] as ConstructionNode[], ...(parent ? { parent } : {}) };
  switch (node.type) {
    case 'document':
    case 'list':
      return { ...links, type: node.type };
    case 'block-quote':
      return { ...links, type: node.type, marker: node.marker };
    case 'list-item':
      return {
        ...links,
        type: node.type,
        marker: node.marker,
        ...(node.checked !== undefined ? { checked: node.checked } : {}),
      };
    case 'paragraph':
      return { ...links, type: node.type, content: node.content };
    case 'section':
      return { ...links, type: node.type, marker: node.marker, content: node.content };
    case 'code-block':
      return { ...links, type: node.type, content: node.content, info: node.info };
  }
}

function recordFromSpec(spec: CreateNodeSpec, id: NodeId): ConstructionNode {
  const links = { id, children: [] as ConstructionNode[] };
  switch (spec.type) {
    case 'paragraph':
      return { ...links, type: spec.type, content: spec.content ?? '' };
    case 'section':
      return { ...links, type: spec.type, marker: spec.marker ?? '#', content: spec.content ?? '' };
    case 'code-block':
      return { ...links, type: spec.type, content: spec.content ?? '', info: spec.info ?? null };
    case 'list':
      return { ...links, type: spec.type };
    case 'list-item':
      return {
        ...links,
        type: spec.type,
        marker: spec.marker ?? '- ',
        ...(spec.checked != null ? { checked: spec.checked } : {}),
      };
    case 'block-quote':
      return { ...links, type: spec.type, marker: spec.marker ?? '> ' };
  }
}

function inlineContent(node: ConstructionNode): string | undefined {
  return node.type === 'paragraph' || node.type === 'section' || node.type === 'code-block'
    ? (node.content ?? '')
    : undefined;
}

function unlink(node: ConstructionNode): void {
  const parent = node.parent;
  if (!parent) return;
  const index = parent.children.indexOf(node);
  if (index >= 0) parent.children.splice(index, 1);
  delete node.parent;
  delete node.previousSibling;
  delete node.nextSibling;
  relink(parent);
}

function relink(parent: ConstructionNode): void {
  for (let index = 0; index < parent.children.length; index++) {
    const child = parent.children[index]!;
    child.parent = parent;
    child.previousSibling = parent.children[index - 1];
    child.nextSibling = parent.children[index + 1];
  }
}

function isAncestor(candidate: ConstructionNode, node: ConstructionNode): boolean {
  let parent: ConstructionNode | undefined = node;
  while (parent) {
    if (parent === candidate) return true;
    parent = parent.parent;
  }
  return false;
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
