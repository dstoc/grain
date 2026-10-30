import { parseBlocks } from '../block-parser/api.js';
import type { DocumentNode, MarkdownNode } from '../node.js';
import { parse as parseInline } from './api.js';
import type { InlineTreeNode } from './ast.js';

export function serializeCommonMarkHtml(markdown: string): string {
  const document = parseBlocks(markdown).node;
  return renderDocument(document);
}

function renderDocument(document: DocumentNode): string {
  return renderBlocks(document.children ?? []);
}

function renderBlocks(nodes: MarkdownNode[]): string {
  return nodes.map(renderBlock).join('');
}

function renderBlock(node: MarkdownNode): string {
  switch (node.type) {
    case 'paragraph':
      return `<p>${renderInlineHtml(node.content)}</p>\n`;
    case 'section': {
      const level = Math.min(node.marker.length, 6);
      return `<h${level}>${renderInlineHtml(node.content)}</h${level}>\n${renderBlocks(
        node.children ?? [],
      )}`;
    }
    case 'list':
      return `<${isOrderedList(node.children) ? 'ol' : 'ul'}>\n${renderListItems(
        node.children ?? [],
      )}</${isOrderedList(node.children) ? 'ol' : 'ul'}>\n`;
    case 'list-item':
      return `<li>${renderBlocks(node.children ?? [])}</li>\n`;
    case 'block-quote':
      return `<blockquote>\n${renderBlocks(node.children ?? [])}</blockquote>\n`;
    case 'code-block':
      return renderCodeBlock(node);
    case 'document':
      return renderBlocks(node.children ?? []);
    default:
      return '';
  }
}

function renderListItems(items: MarkdownNode[]): string {
  return items.map((item) => renderBlock(item)).join('');
}

function isOrderedList(items: MarkdownNode[] | undefined): boolean {
  const firstItem = items?.[0];
  return firstItem?.type === 'list-item' && /^\d+\.\s/u.test(firstItem.marker);
}

function renderCodeBlock(node: Extract<MarkdownNode, { type: 'code-block' }>): string {
  const content = escapeHtmlText(node.content.replace(/\n$/, ''));
  return `<pre><code>${content}\n</code></pre>\n`;
}

function renderInlineHtml(text: string): string {
  const tree = parseInline(text);
  return renderInlineNode(tree.rootNode);
}

function renderInlineNode(node: InlineTreeNode): string {
  switch (node.type) {
    case 'text':
    case 'syntax':
    case 'tag':
      return escapeHtmlText(node.text);
    case 'uri_autolink':
      return renderUriAutolink(node as Extract<InlineTreeNode, { type: 'uri_autolink' }>);
    case 'code_span':
      return `<code>${escapeHtmlText(getPlainText(node.namedChildren))}</code>`;
    case 'emphasis':
      return `<em>${renderInlineNodes(node.namedChildren)}</em>`;
    case 'strong_emphasis':
      return `<strong>${renderInlineNodes(node.namedChildren)}</strong>`;
    case 'strikethrough':
      return `<del>${renderInlineNodes(node.namedChildren)}</del>`;
    case 'inline_link':
      return renderInlineLink(node);
    case 'shortcut_link':
      return `[${getPlainText(node.namedChildren)}]`;
    case 'image':
      return renderImage(node);
    case 'inline_root':
      return renderInlineNodes(node.namedChildren);
    case 'link_text':
      return renderInlineNodes(node.namedChildren);
    case 'link_destination':
    case 'link_title':
      return '';
    default:
      return escapeHtmlText((node as { text?: string }).text ?? '');
  }
}

function renderInlineNodes(nodes: InlineTreeNode[]): string {
  return nodes.map(renderInlineNode).join('');
}

function renderInlineLink(node: Extract<InlineTreeNode, { type: 'inline_link' }>): string {
  const labelNode = findNamedChild(node.namedChildren, 'link_text');
  const destinationNode = findNamedChild(node.namedChildren, 'link_destination');
  const titleNode = findNamedChild(node.namedChildren, 'link_title');

  const href = destinationNode && 'text' in destinationNode ? destinationNode.text : '';
  const title = titleNode && 'text' in titleNode ? titleNode.text : undefined;
  const attrs = [`href="${escapeHtmlAttribute(href)}"`];
  if (title !== undefined) {
    attrs.push(`title="${escapeHtmlAttribute(title)}"`);
  }

  return `<a ${attrs.join(' ')}>${renderInlineNodes(labelNode?.namedChildren ?? [])}</a>`;
}

function renderImage(node: Extract<InlineTreeNode, { type: 'image' }>): string {
  const labelNode = findNamedChild(node.namedChildren, 'link_text');
  const destinationNode = findNamedChild(node.namedChildren, 'link_destination');
  const titleNode = findNamedChild(node.namedChildren, 'link_title');

  const alt = getPlainText(
    labelNode && 'namedChildren' in labelNode ? labelNode.namedChildren : [],
  );
  const src = destinationNode && 'text' in destinationNode ? destinationNode.text : '';
  const attrs = [`src="${escapeHtmlAttribute(src)}"`, `alt="${escapeHtmlAttribute(alt)}"`];
  if (titleNode !== undefined) {
    attrs.push(`title="${escapeHtmlAttribute('text' in titleNode ? titleNode.text : '')}"`);
  }

  return `<img ${attrs.join(' ')} />`;
}

function renderUriAutolink(node: Extract<InlineTreeNode, { type: 'uri_autolink' }>): string {
  const text = 'text' in node ? node.text : '';
  const url = text.startsWith('<') && text.endsWith('>') ? text.slice(1, -1) : text;
  return `<a href="${escapeHtmlAttribute(url)}">${escapeHtmlText(url)}</a>`;
}

function findNamedChild(
  nodes: InlineTreeNode[],
  type: InlineTreeNode['type'],
): InlineTreeNode | undefined {
  return nodes.find((child) => child.type === type);
}

function getPlainText(nodes: InlineTreeNode[]): string {
  return nodes.map(getPlainTextFromNode).join('');
}

function getPlainTextFromNode(node: InlineTreeNode): string {
  switch (node.type) {
    case 'text':
    case 'syntax':
    case 'tag':
      return node.text;
    case 'uri_autolink':
      return 'text' in node ? node.text : '';
    case 'code_span':
      return getPlainText(node.namedChildren);
    case 'emphasis':
    case 'strong_emphasis':
    case 'strikethrough':
    case 'inline_root':
    case 'link_text':
      return getPlainText(node.namedChildren);
    case 'inline_link':
    case 'shortcut_link':
    case 'image':
      return getPlainText(node.namedChildren);
    case 'link_destination':
    case 'link_title':
      return node.text;
    default:
      return '';
  }
}

function escapeHtmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

function escapeHtmlAttribute(text: string): string {
  return escapeHtmlText(text).replace(/"/g, '&quot;');
}
