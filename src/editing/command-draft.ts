import type { TreeDraft } from '../markdown/semantic/draft.js';
import type { NodeId } from '../markdown/semantic/types.js';
import { assertTextRange } from '../markdown/semantic/types.js';

export interface InlineSplit {
  readonly source: NodeId;
  readonly destination: NodeId;
  readonly from: number;
  readonly to: number;
  readonly retainedSide: 'left' | 'right';
}

export interface ChildLift {
  readonly source: NodeId;
  readonly parent: NodeId;
  readonly before: NodeId | null;
  readonly children: readonly NodeId[];
  readonly removeSource: boolean;
}

/** Editing intent, separate from the parser's tree mutation capability. */
export interface CommandDraft extends TreeDraft {
  splitInline(split: InlineSplit): void;
  joinInline(source: NodeId, destination: NodeId): void;
  deleteSubtree(node: NodeId): void;
  liftChildren(lift: ChildLift): void;
}

const adapters = new WeakMap<TreeDraft, CommandDraft>();

/** Legacy callers retain the TreeDraft API; command helpers enter this boundary. */
export function commandDraft(draft: TreeDraft): CommandDraft {
  if (
    'splitInline' in draft &&
    'joinInline' in draft &&
    'deleteSubtree' in draft &&
    'liftChildren' in draft
  )
    return draft as CommandDraft;
  const cached = adapters.get(draft);
  if (cached) return cached;
  const operations = {
    splitInline({ source, destination, from, to, retainedSide }: InlineSplit) {
      const node = draft.node(source);
      if (!('content' in node) || node.content === undefined)
        throw new Error('Split source is not inline');
      assertTextRange(node.content, from, to, 'inline split range');
      if (to > from) draft.spliceText(source, { from, to, insert: '' });
      const length = draft.node(source).content!.length;
      const start = retainedSide === 'left' ? from : 0;
      const end = retainedSide === 'left' ? length : from;
      if (start < end)
        draft.transferInlineRange({
          source,
          destination,
          from: start,
          to: end,
          at: 0,
          affinity: 'left',
        });
    },
    joinInline(source: NodeId, destination: NodeId) {
      const sourceNode = draft.node(source),
        target = draft.node(destination);
      if (sourceNode.content === undefined || target.content === undefined)
        throw new Error('Join requires inline nodes');
      if (sourceNode.content.length)
        draft.transferInlineRange({
          source,
          destination,
          from: 0,
          to: sourceNode.content.length,
          at: target.content.length,
          affinity: 'left',
        });
      draft.detach(source);
    },
    deleteSubtree(node: NodeId) {
      draft.detach(node);
    },
    liftChildren({ source, parent, before, children, removeSource }: ChildLift) {
      for (const child of children) {
        if (draft.parentOf(child) !== source)
          throw new Error('Lift requires observed source children');
      }
      for (const child of children) draft.place(child, parent, before);
      if (removeSource) {
        if (draft.node(source).children.length)
          throw new Error('Cannot remove a nonempty lifted container');
        draft.detach(source);
      }
    },
  };
  const adapter = new Proxy(draft, {
    get(target, key) {
      if (key in operations) return operations[key as keyof typeof operations];
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as CommandDraft;
  adapters.set(draft, adapter);
  return adapter;
}
