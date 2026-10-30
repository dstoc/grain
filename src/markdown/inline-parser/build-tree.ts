import { createSyntaxNode, createTree } from '../parser-tree.js';
import type {
  CodeSpanNode,
  EmphasisNode,
  InlineLeafNode,
  InlineRootNode,
  InlineTree,
  InlineTreeNode,
  ImageNode,
  InlineLinkNode,
  LinkTextNode,
  ShortcutLinkNode,
  StrikethroughNode,
  StrongEmphasisNode,
} from './ast.js';
import type {
  ResolvedCodeSpan,
  ResolvedEmphasis,
  ResolvedImage,
  ResolvedInline,
  ResolvedInlineLink,
  ResolvedShortcutLink,
  ResolvedStrikethrough,
  ResolvedStrongEmphasis,
} from './types.js';

function createPlainTextNode(text: string): InlineLeafNode<'text'> {
  return createSyntaxNode('text', text) as InlineLeafNode<'text'>;
}

function createInlineRootNode(text: string, namedChildren: InlineTreeNode[]): InlineRootNode {
  return createSyntaxNode('inline_root', text, 0, namedChildren) as InlineRootNode;
}

function createPlainTextTree(text: string): InlineTree {
  return createTree(createPlainTextNode(text));
}

function createNodesFromResolvedInline(resolved: ResolvedInline[]): InlineTreeNode[] {
  return resolved.map(createNodeFromResolvedInline);
}

function createNodeFromResolvedInline(resolved: ResolvedInline): InlineTreeNode {
  switch (resolved.type) {
    case 'code_span':
      return createCodeSpanNode(resolved);
    case 'emphasis':
      return createDelimitedNode(resolved);
    case 'inline_link':
      return createInlineLinkNode(resolved);
    case 'shortcut_link':
      return createShortcutLinkNode(resolved);
    case 'image':
      return createImageNode(resolved);
    case 'strong_emphasis':
      return createDelimitedNode(resolved);
    case 'strikethrough':
      return createDelimitedNode(resolved);
    case 'tag':
      return createSyntaxNode('tag', resolved.text, resolved.startIndex) as InlineLeafNode<'tag'>;
    case 'uri_autolink':
      return createSyntaxNode(
        'uri_autolink',
        resolved.text,
        resolved.startIndex,
      ) as InlineLeafNode<'uri_autolink'>;
    case 'syntax':
      return createSyntaxNode(
        'syntax',
        resolved.text,
        resolved.startIndex,
      ) as InlineLeafNode<'syntax'>;
    case 'text':
      return createSyntaxNode('text', resolved.text, resolved.startIndex) as InlineLeafNode<'text'>;
    default:
      throw new Error(`Unsupported inline token type: ${(resolved as { type: string }).type}`);
  }
}

function createInlineTextNode(
  type: 'link_text',
  text: string,
  startIndex: number,
  namedChildren: InlineTreeNode[],
): LinkTextNode;
function createInlineTextNode(
  type: 'link_destination' | 'link_title',
  text: string,
  startIndex: number,
): InlineLeafNode<'link_destination'> | InlineLeafNode<'link_title'>;
function createInlineTextNode(
  type: 'link_text' | 'link_destination' | 'link_title',
  text: string,
  startIndex: number,
  namedChildren: InlineTreeNode[] = [],
): InlineTreeNode {
  return createSyntaxNode(type, text, startIndex, namedChildren) as InlineTreeNode;
}

function createCodeSpanNode(codeSpan: ResolvedCodeSpan): CodeSpanNode {
  const child = createSyntaxNode(
    'text',
    codeSpan.innerText,
    codeSpan.innerStartIndex,
  ) as InlineLeafNode<'text'>;

  return createSyntaxNode('code_span', codeSpan.text, codeSpan.startIndex, [child]) as CodeSpanNode;
}

function createDelimitedNode(
  node: ResolvedEmphasis | ResolvedStrongEmphasis | ResolvedStrikethrough,
): EmphasisNode | StrongEmphasisNode | StrikethroughNode {
  const children = createNodesFromResolvedInline(node.children);

  return createSyntaxNode(node.type, node.text, node.startIndex, children) as
    | EmphasisNode
    | StrongEmphasisNode
    | StrikethroughNode;
}

function createInlineLinkNode(link: ResolvedInlineLink): InlineLinkNode {
  const children = [
    createLinkTextNode(link.label, link.startIndex + 1),
    createInlineTextNode('link_destination', link.destination, link.destinationStartIndex),
  ];

  if (link.title !== undefined) {
    children.push(
      createInlineTextNode('link_title', link.title, link.titleStartIndex ?? link.startIndex),
    );
  }

  return createSyntaxNode('inline_link', link.text, link.startIndex, children) as InlineLinkNode;
}

function createShortcutLinkNode(link: ResolvedShortcutLink): ShortcutLinkNode {
  return createSyntaxNode('shortcut_link', link.text, link.startIndex, [
    createLinkTextNode(link.label, link.startIndex + 1),
  ]) as ShortcutLinkNode;
}

function createImageNode(image: ResolvedImage): ImageNode {
  const children = [
    createLinkTextNode(image.label, image.startIndex + 2),
    createInlineTextNode('link_destination', image.destination, image.destinationStartIndex),
  ];

  if (image.title !== undefined) {
    children.push(
      createInlineTextNode('link_title', image.title, image.titleStartIndex ?? image.startIndex),
    );
  }

  return createSyntaxNode('image', image.text, image.startIndex, children) as ImageNode;
}

function createLinkTextNode(label: ResolvedInline[], fallbackStartIndex: number): LinkTextNode {
  const namedChildren = createNodesFromResolvedInline(label);
  const text = label.map((token) => token.text).join('');
  const startIndex = label[0]?.startIndex ?? fallbackStartIndex;
  return createSyntaxNode('link_text', text, startIndex, namedChildren) as LinkTextNode;
}

export function buildInlineTree(text: string, resolved: ResolvedInline[] = []): InlineTree {
  const nodes = createNodesFromResolvedInline(resolved);
  const hasStructuredNode = nodes.some((node) => node.type !== 'text' && node.type !== 'syntax');

  if (!hasStructuredNode) {
    return createPlainTextTree(text);
  }

  if (nodes.length === 1) {
    return createTree(nodes[0]);
  }

  return createTree(createInlineRootNode(text, nodes));
}
