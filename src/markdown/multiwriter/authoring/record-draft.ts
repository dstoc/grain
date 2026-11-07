import type {
  TreeDraft,
  DraftNode,
  ConversionPlan,
  InlineFragment,
  Transfer,
} from '../../semantic/draft.js';
import type { CreateNodeSpec, NodeId, TextAffinity, TextEdit } from '../../semantic/types.js';
import {
  assertTextEdit,
  assertTextPoint,
  assertTextRange,
  assertWellFormedText,
  isAllowedSemanticChild,
} from '../../semantic/types.js';
import type { CommandViewIndex } from './view-index.js';
import { countWork } from '../diagnostics.js';

interface Links {
  parent?: NodeId;
  previous?: NodeId;
  next?: NodeId;
}
interface Fields {
  type: DraftNode['type'];
  content?: string;
  marker: string | null;
  checked: boolean | null;
  info: string | null;
}

/** Command-private records and links. Published records remain borrowed and immutable.
 * Reading a node or moving a sibling does not enumerate its container or descendants.
 */
export class CommandRecordDraft implements TreeDraft {
  private readonly borrowed = new Map<NodeId, Fields>();
  private readonly borrowedLinks = new Map<NodeId, Links>();
  private readonly fields = new Map<NodeId, Fields>();
  private readonly links = new Map<NodeId, Links>();
  private readonly edges = new Map<NodeId, { first?: NodeId; last?: NodeId }>();
  private readonly views = new Map<NodeId, DraftNode>();
  private readonly fragments = new WeakSet<InlineFragment>();
  private readonly consumed = new WeakSet<InlineFragment>();
  private ordinal = 0;
  constructor(private readonly index: CommandViewIndex) {}

  private read(id: NodeId): Fields {
    const own = this.fields.get(id) ?? this.borrowed.get(id);
    if (own) return own;
    const view = this.index.origins.get(id);
    if (!view) throw new Error(`unknown command node ${id}`);
    const fields = {
      type: view.type,
      content: ['paragraph', 'section', 'code-block'].includes(view.type)
        ? view.content
        : undefined,
      marker: ['section', 'list-item', 'block-quote'].includes(view.type) ? view.marker : null,
      checked: view.type === 'list-item' ? view.checked : null,
      info: view.type === 'code-block' ? view.info : null,
    };
    this.borrowed.set(id, fields);
    countWork('draft.publishedRecordsRead');
    return fields;
  }
  private write(id: NodeId): Fields {
    let fields = this.fields.get(id);
    if (!fields) {
      fields = { ...this.read(id) };
      this.fields.set(id, fields);
      countWork('draft.recordsMaterialized');
    }
    return fields;
  }
  private readLinks(id: NodeId): Links {
    this.read(id);
    const own = this.links.get(id) ?? this.borrowedLinks.get(id);
    if (own) return own;
    const links = { parent: this.index.parents.get(id), ...this.index.siblings.get(id) };
    this.borrowedLinks.set(id, links);
    return links;
  }
  private writeLinks(id: NodeId): Links {
    let links = this.links.get(id);
    if (!links) {
      links = { ...this.readLinks(id) };
      this.links.set(id, links);
      countWork('draft.linksMaterialized');
    }
    return links;
  }
  private childEdges(id: NodeId) {
    this.read(id);
    let edges = this.edges.get(id);
    if (!edges) {
      const children = this.index.origins.get(id)?.children;
      edges = {
        first: children?.length ? this.index.handle(children[0]) : undefined,
        last: children?.length ? this.index.handle(children.at(-1)!) : undefined,
      };
      this.edges.set(id, edges);
    }
    return edges;
  }
  node(id: NodeId): DraftNode {
    this.read(id);
    let view = this.views.get(id);
    if (!view) {
      const fields = () => this.read(id);
      view = Object.freeze({
        id,
        get type() {
          return fields().type;
        },
        get content() {
          return fields().content;
        },
        get marker() {
          return fields().marker;
        },
        get checked() {
          return fields().checked;
        },
        get info() {
          return fields().info;
        },
        get children() {
          return children();
        },
      }) as DraftNode;
      const children = () => {
        const result: NodeId[] = [];
        let child = this.childEdges(id).first;
        while (child) {
          countWork('draft.childEntriesRead');
          result.push(child);
          child = this.nextSiblingOf(child);
        }
        return Object.freeze(result);
      };
      this.views.set(id, view);
      countWork('draft.nodeViewsCreated');
    }
    return view;
  }
  lastChildOf(id: NodeId) {
    return this.childEdges(id).last;
  }
  parentOf(id: NodeId) {
    return this.readLinks(id).parent;
  }
  previousSiblingOf(id: NodeId) {
    return this.readLinks(id).previous;
  }
  nextSiblingOf(id: NodeId) {
    return this.readLinks(id).next;
  }
  create(spec: CreateNodeSpec): NodeId {
    if ((spec as { type: string }).type === 'document')
      throw new Error('Cannot create a document root');
    if ((spec as { children?: unknown[] }).children?.length)
      throw new Error('Place children explicitly');
    const id = `command:${this.ordinal++}`;
    const inline = 'content' in spec || ['paragraph', 'section', 'code-block'].includes(spec.type);
    const content = inline ? ('content' in spec ? (spec.content ?? '') : '') : undefined;
    if (content !== undefined) assertWellFormedText(content);
    this.fields.set(id, {
      type: spec.type,
      content,
      marker:
        spec.type === 'section'
          ? (spec.marker ?? '#')
          : spec.type === 'list-item'
            ? (spec.marker ?? '- ')
            : spec.type === 'block-quote'
              ? (spec.marker ?? '> ')
              : null,
      checked: spec.type === 'list-item' ? (spec.checked ?? null) : null,
      info: spec.type === 'code-block' ? (spec.info ?? null) : null,
    });
    this.links.set(id, {});
    this.edges.set(id, {});
    countWork('draft.recordsCreated');
    return id;
  }
  private unlink(id: NodeId): void {
    const { parent, previous, next } = this.readLinks(id);
    if (!parent) return;
    const edges = this.childEdges(parent);
    if (previous) this.writeLinks(previous).next = next;
    else edges.first = next;
    if (next) this.writeLinks(next).previous = previous;
    else edges.last = previous;
    this.links.set(id, {});
  }
  place(id: NodeId, parent: NodeId, before: NodeId | null): void {
    const node = this.read(id),
      target = this.read(parent);
    if (node.type === 'document') throw new Error('The document root cannot be placed');
    for (let ancestor: NodeId | undefined = parent; ancestor; ancestor = this.parentOf(ancestor))
      if (ancestor === id) throw new Error('Placement would create a cycle');
    if (!isAllowedSemanticChild(target.type, node.type))
      throw new Error(`${node.type} cannot be a child of ${target.type}`);
    if (before && this.parentOf(before) !== parent)
      throw new Error('Reference node is not a destination child');
    if (
      before === id ||
      (this.parentOf(id) === parent && (this.nextSiblingOf(id) ?? null) === before)
    )
      return;
    this.unlink(id);
    const edges = this.childEdges(parent);
    const previous = before ? this.previousSiblingOf(before) : edges.last;
    this.links.set(id, { parent, previous, next: before ?? undefined });
    if (previous) this.writeLinks(previous).next = id;
    else edges.first = id;
    if (before) this.writeLinks(before).previous = id;
    else edges.last = id;
  }
  detach(id: NodeId): void {
    if (this.read(id).type === 'document') throw new Error('The document root cannot be detached');
    if (!this.parentOf(id)) throw new Error('Node is already detached');
    this.unlink(id);
  }
  spliceText(id: NodeId, edit: TextEdit): void {
    const text = this.read(id).content;
    if (text === undefined) throw new Error('Node has no inline text');
    assertTextEdit(text, edit);
    this.write(id).content = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
  }
  bookmark(id: NodeId, offset: number, affinity: TextAffinity) {
    const text = this.read(id).content;
    if (text === undefined) throw new Error('Node has no text bookmarks');
    assertTextPoint(text, offset, 'bookmark offset');
    return Object.freeze({ nodeId: id, offset, affinity });
  }
  cutInline(id: NodeId, from: number, to: number): InlineFragment {
    const text = this.read(id).content;
    if (text === undefined) throw new Error('Node has no inline text');
    assertTextRange(text, from, to, 'cut range');
    if (from === to) throw new Error('Cut range must contain text');
    const fragment = Object.freeze({ text: text.slice(from, to) }) as InlineFragment;
    this.fragments.add(fragment);
    this.spliceText(id, { from, to, insert: '' });
    return fragment;
  }
  insertFragment(id: NodeId, at: number, affinity: TextAffinity, fragment: InlineFragment): void {
    if (!this.fragments.has(fragment) || this.consumed.has(fragment))
      throw new Error('Foreign or consumed command fragment');
    this.bookmark(id, at, affinity);
    this.spliceText(id, { from: at, to: at, insert: fragment.text });
    this.consumed.add(fragment);
  }
  transferInlineRange(t: Transfer): void {
    const source = this.read(t.source).content;
    if (source === undefined) throw new Error('Node has no inline text');
    assertTextRange(source, t.from, t.to, 'transfer range');
    if (t.from === t.to) throw new Error('Transfer range must contain text');
    this.bookmark(t.destination, t.at, t.affinity);
    if (t.source === t.destination) {
      if (t.at === t.from || t.at === t.to) return;
      if (t.from < t.at && t.at < t.to) throw new Error('Transfer destination is inside source');
    }
    const fragment = this.cutInline(t.source, t.from, t.to);
    this.insertFragment(
      t.destination,
      t.source === t.destination && t.at > t.from ? t.at - (t.to - t.from) : t.at,
      t.affinity,
      fragment,
    );
  }
  convertInline(id: NodeId, plan: ConversionPlan): void {
    const current = this.read(id).content;
    if (current === undefined) throw new Error('Node is not inline');
    const content = plan.content?.mode === 'replace' ? plan.content.text : current;
    assertWellFormedText(content);
    Object.assign(this.write(id), {
      type: plan.type,
      content,
      marker: plan.type === 'section' ? (plan.marker ?? '#') : null,
      info: plan.type === 'code-block' ? (plan.info ?? null) : null,
    });
  }
  setMarker(id: NodeId, marker: string | null): void {
    if (!['section', 'list-item'].includes(this.read(id).type) || marker === null)
      throw new Error('Node requires a section or list-item marker');
    this.write(id).marker = marker;
  }
  setChecked(id: NodeId, checked: boolean | null): void {
    if (this.read(id).type !== 'list-item') throw new Error('Node has no checked state');
    this.write(id).checked = checked;
  }
  setInfo(id: NodeId, info: string | null): void {
    if (this.read(id).type !== 'code-block') throw new Error('Node has no code info');
    this.write(id).info = info;
  }
}
