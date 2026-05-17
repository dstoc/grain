import {
  type ParserTree,
  type ParserSyntaxNode,
  createSyntaxNode,
  createTree,
} from './parser-tree.js';

interface InlineSyntaxNodeBase<Type extends string> extends ParserSyntaxNode {
  type: Type;
  namedChildren: InlineTreeNode[];
}

type InlineLeafType =
  | 'formatting' // Any formatting characters or runs, e.g. '[' or ']' in links, '**' for emphasis
  | 'link_destination'
  | 'link_title'
  | 'tag'
  | 'text';

export interface InlineLeafNode<
  Type extends InlineLeafType = InlineLeafType,
> extends InlineSyntaxNodeBase<Type> {
  namedChildren: [];
}

export interface LinkTextNode extends InlineSyntaxNodeBase<'link_text'> {}

export interface EmphasisNode extends InlineSyntaxNodeBase<'emphasis'> {}

export interface StrongEmphasisNode extends InlineSyntaxNodeBase<'strong_emphasis'> {}

export interface StrikethroughNode extends InlineSyntaxNodeBase<'strikethrough'> {}

export interface CodeSpanNode extends InlineSyntaxNodeBase<'code_span'> {}

export interface InlineLinkNode extends InlineSyntaxNodeBase<'inline_link'> {
  namedChildren: InlineTreeNode[];
}

export interface ShortcutLinkNode extends InlineSyntaxNodeBase<'shortcut_link'> {
  namedChildren: InlineTreeNode[];
}

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
  | ShortcutLinkNode
  | StrikethroughNode
  | StrongEmphasisNode
  | UriAutolinkNode;

export type InlineTree = ParserTree<InlineTreeNode>;

function parse(text: string, tree?: InlineTree): InlineTree {
  tree?.delete();
  return createTree(createSyntaxNode('text', text) as InlineLeafNode<'text'>);
}

export const parser = {
  parse,
};
