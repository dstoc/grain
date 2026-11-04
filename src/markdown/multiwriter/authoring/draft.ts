import type { ParserConversionPlan } from '../../block-parser/types.js';
import { isInlineNode } from '../../node.js';
import type { MarkdownNode } from '../../node.js';
import { commandDraft } from '../../../editing/command-draft.js';
import type { ChildLift, CommandDraft, InlineSplit } from '../../../editing/command-draft.js';
import { ConstructionTree } from '../../semantic/construction-tree.js';
import type {
  ConversionPlan,
  DraftNode,
  DraftTextPiece,
  InlineFragment,
  Transfer,
} from '../../semantic/draft.js';
import type { CreateNodeSpec, NodeId, TextAffinity, TextEdit } from '../../semantic/types.js';
import { assertTextEdit, assertTextPoint } from '../../semantic/types.js';
import type { NativeTextRange } from '../contracts.js';
import type { ViewNode } from '../projection/types.js';
import { projectionDocument } from '../projection/project.js';

export type CommandIntent =
  | {
      type: 'interpret';
      id: NodeId;
      plan: ParserConversionPlan;
      handles: ReadonlyMap<string, NodeId>;
    }
  | { type: 'create'; id: NodeId; spec: CreateNodeSpec }
  | { type: 'place'; id: NodeId; parent: NodeId; before: NodeId | null }
  | { type: 'splice'; id: NodeId; edit: TextEdit }
  | { type: 'split'; split: InlineSplit }
  | { type: 'join'; source: NodeId; destination: NodeId }
  | { type: 'delete'; id: NodeId }
  | { type: 'lift'; lift: ChildLift }
  | { type: 'convert'; id: NodeId; plan: ConversionPlan }
  | { type: 'marker'; id: NodeId; marker: string | null }
  | { type: 'checked'; id: NodeId; checked: boolean | null }
  | { type: 'info'; id: NodeId; info: string | null }
  | { type: 'cut'; id: NodeId; from: number; to: number; fragment: InlineFragment }
  | {
      type: 'insert-fragment';
      id: NodeId;
      at: number;
      affinity: TextAffinity;
      fragment: InlineFragment;
    };

export type OriginPiece =
  | { readonly type: 'retained'; readonly text: string; readonly range: NativeTextRange }
  | {
      readonly type: 'buffer';
      readonly text: string;
      readonly buffer: number;
      readonly from: number;
    };
function slicePieces(pieces: readonly OriginPiece[], from: number, to: number): OriginPiece[] {
  const out: OriginPiece[] = [];
  let offset = 0;
  for (const p of pieces) {
    const a = Math.max(from, offset),
      b = Math.min(to, offset + p.text.length);
    if (a < b)
      out.push(
        p.type === 'retained'
          ? {
              ...p,
              text: p.text.slice(a - offset, b - offset),
              range: { ...p.range, clock: p.range.clock + a - offset, length: b - a },
            }
          : { ...p, text: p.text.slice(a - offset, b - offset), from: p.from + a - offset },
      );
    offset += p.text.length;
  }
  return out;
}

/** Isolated semantic records plus native ranges/immutable buffers. Never normalizes shared facts. */
export class MultiwriterCommandDraft implements CommandDraft {
  readonly intents: CommandIntent[] = [];
  readonly origins = new Map<NodeId, ViewNode>();
  readonly pieces = new Map<NodeId, readonly OriginPiece[]>();
  private tree_?: ConstructionTree;
  private readonly parents = new Map<NodeId, NodeId>();
  private readonly siblings = new Map<NodeId, { previous?: NodeId; next?: NodeId }>();
  private readonly handles = new WeakMap<ViewNode, NodeId>();
  private readonly contents = new Map<NodeId, string>();
  private readonly views = new Map<NodeId, DraftNode>();
  readonly rootId: NodeId;
  private readonly fragments = new WeakMap<InlineFragment, readonly OriginPiece[]>();
  private readonly consumed = new WeakSet<InlineFragment>();
  private buffer = 0;
  private readonly textIntents = new Map<
    CommandIntent,
    { before: readonly OriginPiece[]; inserted?: readonly OriginPiece[] }
  >();
  private record(
    intent: CommandIntent,
    before: readonly OriginPiece[],
    inserted?: readonly OriginPiece[],
  ) {
    this.intents.push(intent);
    this.textIntents.set(intent, { before, inserted });
  }
  /** Remove unpublished buffer slices that have no final or parser-observed use.
   * Retained native identities are never pruned. Coordinates stay intent-local. */
  compilerIntents(): readonly CommandIntent[] {
    const live = new Map<number, { from: number; to: number }[]>();
    const retain = (pieces: readonly OriginPiece[]) => {
      for (const p of pieces)
        if (p.type === 'buffer') {
          const ranges = live.get(p.buffer) ?? [];
          ranges.push({ from: p.from, to: p.from + p.text.length });
          live.set(p.buffer, ranges);
        }
    };
    for (const [id, pieces] of this.pieces) {
      let node: NodeId | undefined = id;
      while (node && node !== this.rootId) node = this.parentOf(node);
      if (node === this.rootId) retain(pieces);
    }
    for (const [intent, state] of this.textIntents)
      if (intent.type === 'interpret') {
        retain(state.before);
        retain(state.inserted ?? []);
      }
    const kept = (pieces: readonly OriginPiece[]) =>
      pieces
        .flatMap((p) => {
          if (p.type === 'retained') return [p.text];
          const spans = (live.get(p.buffer) ?? [])
            .map((r) => ({
              from: Math.max(r.from, p.from),
              to: Math.min(r.to, p.from + p.text.length),
            }))
            .filter((r) => r.from < r.to)
            .sort((a, b) => a.from - b.from);
          let end = p.from;
          return spans.flatMap((r) => {
            const from = Math.max(end, r.from);
            end = Math.max(end, r.to);
            return from < r.to ? [p.text.slice(from - p.from, r.to - p.from)] : [];
          });
        })
        .join('');
    return this.intents.map((intent) => {
      const state = this.textIntents.get(intent);
      if (!state) return intent;
      const offset = (at: number) => kept(slicePieces(state.before, 0, at)).length;
      switch (intent.type) {
        case 'create':
          return {
            ...intent,
            spec:
              'content' in intent.spec
                ? { ...intent.spec, content: kept(state.inserted ?? []) }
                : intent.spec,
          };
        case 'splice':
          return {
            ...intent,
            edit: {
              ...intent.edit,
              from: offset(intent.edit.from),
              to: offset(intent.edit.to),
              insert: kept(state.inserted ?? []),
            },
          };
        case 'split':
          return {
            ...intent,
            split: {
              ...intent.split,
              from: offset(intent.split.from),
              to: offset(intent.split.to),
            },
          };
        case 'cut':
          return { ...intent, from: offset(intent.from), to: offset(intent.to) };
        case 'insert-fragment':
          return { ...intent, at: offset(intent.at) };
        case 'convert':
          return intent.plan.content?.mode === 'replace'
            ? {
                ...intent,
                plan: {
                  ...intent.plan,
                  content: { mode: 'replace' as const, text: kept(state.inserted ?? []) },
                },
              }
            : intent;
        default:
          return intent;
      }
    });
  }
  constructor(
    private readonly root: ViewNode,
    overlay = false,
  ) {
    let ordinal = 0;
    const visit = (view: ViewNode, parent?: NodeId) => {
      const id = `construction:${ordinal++}`;
      this.origins.set(id, view);
      this.handles.set(view, id);
      if (parent) this.parents.set(id, parent);
      view.children.forEach((child) => visit(child, id));
      view.children.forEach((child, i) =>
        this.siblings.set(this.handles.get(child)!, {
          previous: view.children[i - 1] && this.handles.get(view.children[i - 1]),
          next: view.children[i + 1] && this.handles.get(view.children[i + 1]),
        }),
      );
    };
    visit(root);
    this.rootId = 'construction:0';
    if (!overlay) {
      void this.tree;
      for (const id of this.origins.keys()) this.originPieces(id);
    }
  }
  /** Structural commands keep the established isolated tree. Literal edits stay in an overlay. */
  get tree(): ConstructionTree {
    if (!this.tree_) {
      const tree = new ConstructionTree(projectionDocument({ root: this.root, emptyRoot: null }));
      for (const [id, content] of this.contents) {
        const before = tree.draft.node(id).content!;
        tree.draft.spliceText(id, { from: 0, to: before.length, insert: content });
      }
      this.tree_ = tree;
    }
    return this.tree_;
  }
  private originPieces(id: NodeId): readonly OriginPiece[] {
    let pieces = this.pieces.get(id);
    if (!pieces) {
      pieces =
        this.origins
          .get(id)
          ?.fragments.filter((p) => p.visible)
          .map((p) => ({ type: 'retained' as const, text: p.text, range: p.range })) ?? [];
      this.pieces.set(id, pieces);
    }
    return pieces;
  }
  node(id: NodeId): DraftNode {
    if (this.tree_) return this.tree_.draft.node(id);
    const cached = this.views.get(id);
    if (cached) return cached;
    const view = this.origins.get(id);
    if (!view) throw new Error(`unknown construction node ${id}`);
    const read = () => this.tree_?.draft.node(id);
    const inline = ['paragraph', 'section', 'code-block'].includes(view.type);
    const content = () => this.contents.get(id) ?? view.content;
    const children = () => Object.freeze(view.children.map((child) => this.handles.get(child)!));
    const result = Object.freeze({
      id,
      get type() {
        return read()?.type ?? view.type;
      },
      get content() {
        return read() ? read()!.content : inline ? content() : undefined;
      },
      get children() {
        return read()?.children ?? children();
      },
      get marker() {
        return read()
          ? read()!.marker
          : ['section', 'list-item', 'block-quote'].includes(view.type)
            ? view.marker
            : null;
      },
      get info() {
        return read() ? read()!.info : view.type === 'code-block' ? view.info : null;
      },
      get checked() {
        return read() ? read()!.checked : view.type === 'list-item' ? view.checked : null;
      },
    }) as DraftNode;
    this.views.set(id, result);
    return result;
  }
  parentOf(id: NodeId) {
    return this.tree_ ? this.tree_.draft.parentOf(id) : this.parents.get(id);
  }
  previousSiblingOf(id: NodeId) {
    return this.tree_ ? this.tree_.draft.previousSiblingOf(id) : this.siblings.get(id)?.previous;
  }
  nextSiblingOf(id: NodeId) {
    return this.tree_ ? this.tree_.draft.nextSiblingOf(id) : this.siblings.get(id)?.next;
  }
  bookmark(id: NodeId, offset: number, affinity: TextAffinity) {
    if (this.tree_) return this.tree_.draft.bookmark(id, offset, affinity);
    const text = this.node(id).content;
    if (text === undefined) throw new Error('Node has no text bookmarks');
    assertTextPoint(text, offset, 'bookmark offset');
    return Object.freeze({ nodeId: id, offset, affinity });
  }
  private literal(text: string): OriginPiece[] {
    return text ? [{ type: 'buffer', text, buffer: this.buffer++, from: 0 }] : [];
  }
  private replace(id: NodeId, from: number, to: number, insert: readonly OriginPiece[]) {
    const p = this.originPieces(id);
    this.pieces.set(id, [...slicePieces(p, 0, from), ...insert, ...slicePieces(p, to, Infinity)]);
  }
  create(spec: CreateNodeSpec): NodeId {
    const id = this.tree.draft.create(spec);
    this.pieces.set(id, this.literal('content' in spec ? (spec.content ?? '') : ''));
    this.record({ type: 'create', id, spec: structuredClone(spec) }, [], this.pieces.get(id));
    return id;
  }
  place(id: NodeId, parent: NodeId, before: NodeId | null): void {
    if (this.parentOf(id) === parent && (this.nextSiblingOf(id) ?? null) === before) return;
    this.tree.draft.place(id, parent, before);
    this.intents.push({ type: 'place', id, parent, before });
  }
  detach(): never {
    throw new Error('Use explicit delete, join or lift intent in a command draft');
  }
  deleteSubtree(id: NodeId): void {
    this.tree.draft.detach(id);
    this.intents.push({ type: 'delete', id });
  }
  liftChildren(lift: ChildLift): void {
    commandDraft(this.tree.draft).liftChildren(lift);
    this.intents.push({ type: 'lift', lift: structuredClone(lift) });
  }
  spliceText(id: NodeId, edit: TextEdit): void {
    const before = this.node(id).content;
    if (this.tree_) this.tree_.draft.spliceText(id, edit);
    else {
      if (before === undefined) throw new Error('Node has no inline text');
      assertTextEdit(before, edit);
      this.contents.set(id, before.slice(0, edit.from) + edit.insert + before.slice(edit.to));
    }
    if (before === this.node(id).content) return;
    const pieces = this.originPieces(id),
      inserted = this.literal(edit.insert);
    this.replace(id, edit.from, edit.to, inserted);
    this.record({ type: 'splice', id, edit: structuredClone(edit) }, pieces, inserted);
  }
  splitInline(split: InlineSplit): void {
    const { source, destination, from, to, retainedSide } = split;
    const p = this.originPieces(source);
    const remaining = [...slicePieces(p, 0, from), ...slicePieces(p, to, Infinity)];
    commandDraft(this.tree.draft).splitInline(split);
    this.pieces.set(
      source,
      retainedSide === 'left'
        ? slicePieces(remaining, 0, from)
        : slicePieces(remaining, from, Infinity),
    );
    this.pieces.set(
      destination,
      retainedSide === 'left'
        ? slicePieces(remaining, from, Infinity)
        : slicePieces(remaining, 0, from),
    );
    this.record({ type: 'split', split: structuredClone(split) }, p);
  }
  joinInline(source: NodeId, destination: NodeId): void {
    commandDraft(this.tree.draft).joinInline(source, destination);
    this.pieces.set(destination, [...this.originPieces(destination), ...this.originPieces(source)]);
    this.pieces.set(source, []);
    this.intents.push({ type: 'join', source, destination });
  }
  cutInline(id: NodeId, from: number, to: number): InlineFragment {
    const before = this.originPieces(id);
    const pieces = slicePieces(before, from, to);
    const fragment = this.tree.draft.cutInline(id, from, to);
    this.fragments.set(fragment, pieces);
    this.replace(id, from, to, []);
    this.record({ type: 'cut', id, from, to, fragment }, before);
    return fragment;
  }
  insertFragment(id: NodeId, at: number, affinity: TextAffinity, fragment: InlineFragment): void {
    const p = this.fragments.get(fragment);
    if (!p || this.consumed.has(fragment)) throw new Error('Foreign or consumed command fragment');
    const before = this.originPieces(id);
    this.tree.draft.insertFragment(id, at, affinity, fragment);
    this.replace(id, at, at, p);
    this.consumed.add(fragment);
    this.record({ type: 'insert-fragment', id, at, affinity, fragment }, before);
  }
  transferInlineRange(t: Transfer): void {
    // Validate all coordinates before cutting, including same-node pre-transfer coordinates.
    const source = this.node(t.source).content,
      destination = this.node(t.destination).content;
    if (source === undefined || destination === undefined)
      throw new Error('Transfer needs inline content');
    this.tree.draft.bookmark(t.destination, t.at, t.affinity);
    if (t.source === t.destination) {
      if (t.at === t.from || t.at === t.to) return;
      if (t.from < t.at && t.at < t.to) throw new Error('Transfer destination is inside source');
    }
    const fragment = this.cutInline(t.source, t.from, t.to);
    const at = t.source === t.destination && t.at > t.from ? t.at - (t.to - t.from) : t.at;
    this.insertFragment(t.destination, at, t.affinity, fragment);
  }
  convertInline(id: NodeId, plan: ConversionPlan): void {
    const before = this.node(id).content,
      pieces = this.originPieces(id);
    this.tree.draft.convertInline(id, plan);
    if (plan.content?.mode === 'replace' && before !== plan.content.text)
      this.pieces.set(id, this.literal(plan.content.text));
    this.record({ type: 'convert', id, plan: structuredClone(plan) }, pieces, this.pieces.get(id));
  }
  setMarker(id: NodeId, marker: string | null): void {
    if (this.node(id).marker === marker) return;
    this.tree.draft.setMarker(id, marker);
    this.intents.push({ type: 'marker', id, marker });
  }
  setChecked(id: NodeId, checked: boolean | null): void {
    if (this.node(id).checked === checked) return;
    this.tree.draft.setChecked(id, checked);
    this.intents.push({ type: 'checked', id, checked });
  }
  setInfo(id: NodeId, info: string | null): void {
    if (this.node(id).info === info) return;
    this.tree.draft.setInfo(id, info);
    this.intents.push({ type: 'info', id, info });
  }
  /** Apply a parser plan to this isolated draft; native binding remains compiler-owned. */
  interpret(id: NodeId, plan: ParserConversionPlan): readonly NodeId[] {
    const source = this.originPieces(id),
      parent = this.parentOf(id);
    if (!parent) throw new Error('Parser source is detached');
    const before = this.nextSiblingOf(id) ?? null;
    const handles = new Map<string, NodeId>();
    let first = true;
    const visit = (node: MarkdownNode, path: number[], parent: NodeId) => {
      const key = path.join('.'),
        inline = isInlineNode(node),
        stable = inline && first;
      if (inline) first = false;
      if (node.type === 'document') throw new Error('Parser output cannot contain a document');
      const { children: _children, ...spec } = node;
      const handle = stable ? id : this.tree.draft.create(spec);
      if (stable)
        this.tree.draft.convertInline(id, {
          type: node.type as 'paragraph' | 'section' | 'code-block',
          ...('marker' in node ? { marker: node.marker } : {}),
          ...(node.type === 'code-block' ? { info: node.info } : {}),
          content: { mode: 'replace', text: node.content! },
        });
      this.tree.draft.place(handle, parent, path.length === 1 ? before : null);
      handles.set(key, handle);
      this.pieces.set(
        handle,
        inline
          ? plan.inlinePieces[key].flatMap((p) =>
              p.kind === 'retain'
                ? slicePieces(source, p.sourceFrom, p.sourceTo)
                : this.literal(p.text),
            )
          : [],
      );
      for (const [i, child] of (node.children ?? []).entries()) visit(child, [...path, i], handle);
    };
    for (const [i, node] of (plan.output.children ?? []).entries()) visit(node, [i], parent);
    this.record(
      { type: 'interpret', id, plan: structuredClone(plan), handles },
      source,
      [...handles.values()].flatMap((id) => this.originPieces(id)),
    );
    return [...handles.values()];
  }
  sourcePieces(id: NodeId): readonly DraftTextPiece[] {
    let from = 0;
    return this.originPieces(id).map((p) => {
      const start = from;
      from += p.text.length;
      return { from: start, to: from, kind: p.type === 'retained' ? 'existing' : 'inserted' };
    });
  }
}
