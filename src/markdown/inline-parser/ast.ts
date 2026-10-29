import { type ParserSyntaxNode, type ParserTree } from '../parser-tree.js';

interface InlineSyntaxNodeBase<Type extends string> extends ParserSyntaxNode {
  type: Type;
  namedChildren: InlineTreeNode[];
}

export type InlineLeafType =
  // 'syntax' is syntax-only text that should remain distinguishable from
  // user-visible text.
  // For example, the '[' and ']' around a link can be hidden via styling while
  // the nested link text remains visible.
  | 'syntax'
  | 'link_destination'
  | 'link_title'
  // Extension syntax for tags: '#' followed by a non-numeric, non-punctuation
  // first character, then any mix of letters, numbers, '_', '-', '/', and
  // commonly accepted Unicode characters including emoji and other symbols.
  | 'tag'
  | 'uri_autolink'
  | 'text';

export interface InlineLeafNode<
  Type extends InlineLeafType = InlineLeafType,
> extends InlineSyntaxNodeBase<Type> {
  namedChildren: [];
}

export interface InlineRootNode extends InlineSyntaxNodeBase<'inline_root'> {
  namedChildren: InlineTreeNode[];
}

export type LinkTextNode = InlineSyntaxNodeBase<'link_text'>;

export type EmphasisNode = InlineSyntaxNodeBase<'emphasis'>;

export type StrongEmphasisNode = InlineSyntaxNodeBase<'strong_emphasis'>;

export type StrikethroughNode = InlineSyntaxNodeBase<'strikethrough'>;

export type CodeSpanNode = InlineSyntaxNodeBase<'code_span'>;

// [label](destination "title"): link text and destination are distinct children.
export interface InlineLinkNode extends InlineSyntaxNodeBase<'inline_link'> {
  namedChildren: InlineTreeNode[];
}

// [label]: bracketed shortcut form
export interface ShortcutLinkNode extends InlineSyntaxNodeBase<'shortcut_link'> {
  namedChildren: InlineTreeNode[];
}

// <https://example.com>: autolink form where the destination can be derived
// directly from the node text when no explicit child carries it.
export interface UriAutolinkNode extends InlineSyntaxNodeBase<'uri_autolink'> {
  namedChildren: InlineTreeNode[];
}

export interface ImageNode extends InlineSyntaxNodeBase<'image'> {
  namedChildren: InlineTreeNode[];
}

export type InlineTreeNode =
  | CodeSpanNode
  | EmphasisNode
  | ImageNode
  | InlineLeafNode
  | InlineLinkNode
  | LinkTextNode
  | InlineRootNode
  | ShortcutLinkNode
  | StrikethroughNode
  | StrongEmphasisNode
  | UriAutolinkNode;

// A concrete syntax tree
export type InlineTree = ParserTree<InlineTreeNode>;
