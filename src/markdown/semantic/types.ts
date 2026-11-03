import type { MarkdownNode } from '../node.js';

export type NodeId = string;
export type NodeKind = MarkdownNode['type'];
export type InlineNodeKind = 'paragraph' | 'section' | 'code-block';
export type TextAffinity = 'left' | 'right';

export function isInlineNodeKind(kind: NodeKind): kind is InlineNodeKind {
  return kind === 'paragraph' || kind === 'section' || kind === 'code-block';
}

export interface TextEdit {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
  readonly affinity?: TextAffinity;
  /** Select an otherwise empty canonical span when a bookmark identifies one. */
  readonly spanIndex?: number;
}

export type CreateNodeSpec =
  | { readonly type: 'paragraph'; readonly content?: string }
  | { readonly type: 'section'; readonly content?: string; readonly marker?: string }
  | { readonly type: 'code-block'; readonly content?: string; readonly info?: string | null }
  | { readonly type: 'list' }
  | { readonly type: 'list-item'; readonly marker?: string; readonly checked?: boolean | null }
  | { readonly type: 'block-quote'; readonly marker?: string };

export function splitsSurrogatePair(value: string, offset: number): boolean {
  return (
    offset > 0 &&
    offset < value.length &&
    value.charCodeAt(offset - 1) >= 0xd800 &&
    value.charCodeAt(offset - 1) <= 0xdbff &&
    value.charCodeAt(offset) >= 0xdc00 &&
    value.charCodeAt(offset) <= 0xdfff
  );
}

export function assertTextRange(
  value: string,
  from: number,
  to: number,
  label = 'text range',
): void {
  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    throw new Error(`${label} offsets must be integers`);
  }
  if (from < 0 || to < from || to > value.length) {
    throw new Error(`${label} is out of bounds`);
  }
  if (splitsSurrogatePair(value, from) || splitsSurrogatePair(value, to)) {
    throw new Error(`${label} splits a surrogate pair`);
  }
}

export function assertWellFormedText(value: string, label = 'text'): void {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error(`${label} contains an unpaired high surrogate`);
      }
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new Error(`${label} contains an unpaired low surrogate`);
    }
  }
}

export function assertTextEdit(value: string, edit: TextEdit): void {
  assertTextRange(value, edit.from, edit.to);
  assertWellFormedText(edit.insert, 'inserted text');
}

export function assertTextPoint(value: string, offset: number, label: string): void {
  assertTextRange(value, offset, offset, label);
}
