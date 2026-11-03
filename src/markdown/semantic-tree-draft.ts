import type {
  ConversionPlan,
  DraftNode,
  InlineFragment,
  TreeDraft,
  Transfer,
} from './semantic/draft.js';
import type { CreateNodeSpec, NodeId, TextAffinity, TextEdit } from './semantic/types.js';
import { assertTextEdit, assertTextPoint, assertTextRange } from './semantic/types.js';
import type { TextPoint } from './semantic/selection.js';
import type { MarkdownNode } from './node.js';
import { isInlineViewModelNode, viewModel, type ViewModelNode } from './view-model-node.js';
import { MarkdownTree } from './view-model.js';

/**
 * A semantic draft over an in-memory MarkdownTree. Parser construction and
 * snapshot resume use this adapter; it creates no Yjs document or shared type.
 */
export class MarkdownTreeDraft implements TreeDraft {
  private readonly ids = new WeakMap<ViewModelNode, NodeId>();
  private readonly nodes = new Map<NodeId, ViewModelNode>();
  private readonly views = new Map<NodeId, DraftNode>();
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
  createNode(spec: CreateNodeSpec): ViewModelNode {
    return this.view(this.create(spec));
  }

  /** Parser convenience for placement of nodes whose view references are cached. */
  placeNodes(id: ViewModelNode, parent: ViewModelNode, before?: ViewModelNode): void {
    this.place(this.idOf(id), this.idOf(parent), before ? this.idOf(before) : null);
  }

  detachNode(node: ViewModelNode): void {
    this.detach(this.idOf(node));
  }

  /** Parser cleanup that intentionally tolerates an unattached node. */
  detachNodeIfAttached(node: ViewModelNode): void {
    const id = this.idOf(node);
    if (this.parentOf(id) !== undefined) this.detach(id);
  }

  editNode(node: ViewModelNode, from: number, to: number, insert: string): void {
    this.spliceText(this.idOf(node), { from, to, insert });
  }

  node(id: NodeId): DraftNode {
    const cached = this.views.get(id);
    if (cached) return cached;
    this.view(id);
    const view = Object.defineProperties(
      { id },
      {
        type: { enumerable: true, get: () => this.view(id).type },
        children: {
          enumerable: true,
          get: () =>
            Object.freeze(
              [...(this.view(id).children ?? [])].map((child) => this.idOf(child as ViewModelNode)),
            ),
        },
        content: {
          enumerable: true,
          get: () => {
            const current = this.view(id);
            return isInlineViewModelNode(current) ? current.content : undefined;
          },
        },
        marker: {
          enumerable: true,
          get: () => {
            const current = this.view(id);
            return 'marker' in current ? current.marker : null;
          },
        },
        checked: {
          enumerable: true,
          get: () => {
            const current = this.view(id);
            return current.type === 'list-item' ? (current.checked ?? null) : null;
          },
        },
        info: {
          enumerable: true,
          get: () => {
            const current = this.view(id);
            return current.type === 'code-block' ? current.info : null;
          },
        },
      },
    ) as DraftNode;
    Object.freeze(view);
    this.views.set(id, view);
    return view;
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
    expect(node !== this.tree.root, 'the document root cannot be detached');
    expect(node[viewModel].parent, `node ${id} is already detached`);
    node[viewModel].remove();
  }

  spliceText(id: NodeId, edit: TextEdit): void {
    const node = this.view(id);
    expect(isInlineViewModelNode(node), `${node.type} has no inline text`);
    assertTextEdit(node.content, edit);
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
    assertTextRange(node.content, from, to, 'cut range');
    expect(to > from, 'cut range must contain text');
    const fragment = Object.freeze({ text: node.content.slice(from, to) }) as InlineFragment;
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
    const target = this.view(destination);
    expect(isInlineViewModelNode(target), `${target.type} has no inline text`);
    assertTextPoint(target.content, at, 'fragment target');
    this.spliceText(destination, { from: at, to: at, insert: owned.text });
    this.consumedFragments.add(fragment);
  }

  transferInlineRange(transfer: Transfer): void {
    const source = this.view(transfer.source);
    const destination = this.view(transfer.destination);
    expect(isInlineViewModelNode(source), `${source.type} has no inline text`);
    expect(isInlineViewModelNode(destination), `${destination.type} has no inline text`);
    assertTextRange(source.content, transfer.from, transfer.to, 'transfer range');
    expect(transfer.to > transfer.from, 'transfer range must contain text');
    const destinationText =
      transfer.source === transfer.destination ? source.content : destination.content;
    assertTextPoint(destinationText, transfer.at, 'transfer destination');
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

  bookmark(id: NodeId, offset: number, affinity: TextAffinity): TextPoint {
    const node = this.view(id);
    expect(isInlineViewModelNode(node), `${node.type} has no text bookmarks`);
    assertTextPoint(node.content, offset, 'bookmark offset');
    return Object.freeze({ nodeId: id, offset, affinity });
  }
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function nodeFromSpec(spec: CreateNodeSpec): MarkdownNode {
  expect(
    (spec as unknown as { readonly type: string }).type !== 'document',
    'a semantic draft cannot create another root',
  );
  switch (spec.type) {
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
