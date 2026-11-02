import type {
  Bookmark,
  ConversionPlan,
  DraftNode,
  InlineFragment,
  NodeSpec,
  TreeDraft,
  Transfer,
} from './canonical-actions.js';
import type { NodeId } from './canonical-model.js';
import type { MarkdownNode } from './node.js';
import type { TextAffinity, TextEdit } from './canonical-text.js';
import { isInlineViewModelNode, viewModel, type ViewModelNode } from './view-model-node.js';
import { MarkdownTree } from './view-model.js';

/**
 * A semantic draft over an in-memory MarkdownTree. Parser construction and
 * snapshot resume use this adapter; it creates no Yjs document or shared type.
 */
export class MarkdownTreeDraft implements TreeDraft {
  private readonly ids = new WeakMap<ViewModelNode, NodeId>();
  private readonly nodes = new Map<NodeId, ViewModelNode>();
  private readonly fragments = new WeakMap<object, { readonly text: string }>();
  private readonly consumedFragments = new WeakSet<object>();
  private nextId = 0;
  readonly rootId: NodeId;

  constructor(readonly tree: MarkdownTree) {
    this.rootId = this.idOf(tree.root);
  }

  idOf(node: ViewModelNode): NodeId {
    const existing = this.ids.get(node);
    if (existing) return existing;
    const id = `semantic:${this.nextId++}`;
    this.ids.set(node, id);
    this.nodes.set(id, node);
    return id;
  }

  view(id: NodeId): ViewModelNode {
    const node = this.nodes.get(id);
    expect(node, `unknown semantic node ${id}`);
    return node;
  }

  /** Parser convenience that still records creation through the draft API. */
  createNode(spec: NodeSpec): ViewModelNode {
    return this.view(this.create(spec));
  }

  /** Parser convenience for placement of nodes whose view references are cached. */
  placeNodes(id: ViewModelNode, parent: ViewModelNode, before?: ViewModelNode): void {
    this.place(this.idOf(id), this.idOf(parent), before ? this.idOf(before) : null);
  }

  detachNode(node: ViewModelNode): void {
    this.detach(this.idOf(node));
  }

  editNode(node: ViewModelNode, from: number, to: number, insert: string): void {
    this.spliceText(this.idOf(node), { from, to, insert });
  }

  node(id: NodeId): DraftNode {
    const node = this.view(id);
    return Object.freeze({
      id,
      type: node.type,
      children: Object.freeze(
        (node.children ?? []).map((child) => this.idOf(child as ViewModelNode)),
      ),
      spans: Object.freeze([]),
      ...(isInlineViewModelNode(node) ? { content: node.content } : {}),
      marker: 'marker' in node ? node.marker : null,
      checked: node.type === 'list-item' ? (node.checked ?? null) : null,
      info: node.type === 'code-block' ? node.info : null,
    });
  }

  parentOf(id: NodeId): NodeId | undefined {
    const parent = this.view(id)[viewModel].parent;
    return parent ? this.idOf(parent) : undefined;
  }

  previousSiblingOf(id: NodeId): NodeId | undefined {
    const sibling = this.view(id)[viewModel].previousSibling;
    return sibling ? this.idOf(sibling) : undefined;
  }

  nextSiblingOf(id: NodeId): NodeId | undefined {
    const sibling = this.view(id)[viewModel].nextSibling;
    return sibling ? this.idOf(sibling) : undefined;
  }

  create(spec: NodeSpec): NodeId {
    expect(spec.type !== 'document', 'a semantic draft cannot create another root');
    const node = this.tree.add(nodeFromSpec(spec));
    return this.idOf(node);
  }

  place(id: NodeId, parent: NodeId, before: NodeId | null): void {
    this.view(id)[viewModel].insertBefore(
      this.view(parent),
      before === null ? undefined : this.view(before),
    );
  }

  detach(id: NodeId): void {
    const node = this.view(id);
    if (node[viewModel].parent) node[viewModel].remove();
  }

  spliceText(id: NodeId, edit: TextEdit): void {
    const node = this.view(id);
    expect(isInlineViewModelNode(node), `${node.type} has no inline text`);
    expect(
      Number.isInteger(edit.from) &&
        Number.isInteger(edit.to) &&
        edit.from >= 0 &&
        edit.to >= edit.from &&
        edit.to <= node.content.length,
      'text edit is outside the inline node',
    );
    node[viewModel].edit(
      {
        startIndex: edit.from,
        oldEndIndex: edit.to,
        newEndIndex: edit.from + edit.insert.length,
        newText: edit.insert,
      },
      false,
    );
  }

  cutInline(id: NodeId, from: number, to: number): InlineFragment {
    const node = this.view(id);
    expect(isInlineViewModelNode(node), `${node.type} has no inline text`);
    expect(from >= 0 && to >= from && to <= node.content.length, 'cut range is outside the inline');
    const fragment = Object.freeze({ text: node.content.slice(from, to) });
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
    expect(owned, 'fragment was not created by this semantic draft');
    expect(!this.consumedFragments.has(fragment), 'fragment has already been inserted');
    this.consumedFragments.add(fragment);
    this.spliceText(destination, { from: at, to: at, insert: owned.text });
  }

  transferInlineRange(transfer: Transfer): void {
    const fragment = this.cutInline(transfer.source, transfer.from, transfer.to);
    const at =
      transfer.source === transfer.destination && transfer.at > transfer.from
        ? Math.max(transfer.from, transfer.at - (transfer.to - transfer.from))
        : transfer.at;
    this.insertFragment(transfer.destination, at, transfer.affinity, fragment);
  }

  convertInline(id: NodeId, plan: ConversionPlan): void {
    const node = this.view(id);
    expect(isInlineViewModelNode(node), `${node.type} is not an inline node`);
    const content = plan.content?.mode === 'replace' ? plan.content.text : node.content;
    node[viewModel].convertInline({
      type: plan.type,
      content,
      marker: plan.type === 'section' ? (plan.marker ?? '#') : null,
      info: plan.type === 'code-block' ? (plan.info ?? null) : null,
    });
  }

  setMarker(id: NodeId, marker: string | null): void {
    const node = this.view(id);
    expect(node.type === 'section' || node.type === 'list-item', `${node.type} has no marker`);
    expect(marker !== null, 'Markdown section and list-item markers cannot be null');
    node[viewModel].updateMarker(marker);
  }

  setChecked(id: NodeId, checked: boolean | null): void {
    const node = this.view(id);
    expect(node.type === 'list-item', `${node.type} has no checked state`);
    node[viewModel].updateChecked(checked ?? undefined);
  }

  setInfo(id: NodeId, info: string | null): void {
    const node = this.view(id);
    expect(node.type === 'code-block', `${node.type} has no code info`);
    node[viewModel].updateInfo(info);
  }

  bookmark(id: NodeId, offset: number, affinity: TextAffinity, spanIndex?: number): Bookmark {
    const node = this.view(id);
    expect(isInlineViewModelNode(node), `${node.type} has no text bookmarks`);
    expect(
      Number.isInteger(offset) && offset >= 0 && offset <= node.content.length,
      'bookmark is outside the inline',
    );
    return Object.freeze({
      nodeId: id,
      offset,
      affinity,
      ...(spanIndex === undefined ? {} : { spanIndex }),
    });
  }
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function nodeFromSpec(spec: NodeSpec): MarkdownNode {
  switch (spec.type) {
    case 'document':
      throw new Error('a semantic draft cannot create another root');
    case 'paragraph':
      return { type: 'paragraph', content: spec.content ?? '' };
    case 'section':
      return {
        type: 'section',
        marker: spec.marker ?? '#',
        content: spec.content ?? '',
        children: [],
      };
    case 'code-block':
      return { type: 'code-block', info: spec.info ?? null, content: spec.content ?? '' };
    case 'list':
      return { type: 'list', children: [] };
    case 'list-item':
      return {
        type: 'list-item',
        marker: spec.marker ?? '- ',
        checked: spec.checked ?? undefined,
        children: [],
      };
    case 'block-quote':
      return { type: 'block-quote', marker: spec.marker ?? '> ', children: [] };
  }
}
