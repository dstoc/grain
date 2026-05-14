import type {DocumentNode, MarkdownNode} from './node.js';
import {type ParserEdit, type ParserTree, createSyntaxNode, createTree} from './parser-tree.js';

export type Tree = ParserTree;

export function parseBlocks(
  markdown: string,
  tree?: ParserTree,
  _edit?: ParserEdit,
  keepTree = false,
) {
  tree?.delete();
  const node = parseDocument(markdown);
  const rootTree = createTree(createSyntaxNode('document', markdown));
  return {node, tree: keepTree ? rootTree : (rootTree.delete(), undefined)};
}

function parseDocument(markdown: string): DocumentNode {
  const content = markdown.replace(/\n+$/, '');
  const children: MarkdownNode[] =
    content === '' ? [{type: 'paragraph', content: ''}] : parseLines(content);
  return {type: 'document', children};
}

function parseLines(markdown: string): MarkdownNode[] {
  const lines = markdown.split('\n');
  const nodes: MarkdownNode[] = [];

  for (const line of lines) {
    if (line.trim() === '') {
      continue;
    }

    const section = parseSection(line);
    if (section) {
      nodes.push(section);
      continue;
    }

      const listItem = parseListItem(line);
    if (listItem) {
      const last = nodes.at(-1);
      if (last?.type === 'list' && last.children) {
        last.children.push(listItem);
      } else {
        nodes.push({type: 'list', children: [listItem]});
      }
      continue;
    }

    const blockQuote = parseBlockQuote(line);
    if (blockQuote) {
      nodes.push(blockQuote);
      continue;
    }

    nodes.push({type: 'paragraph', content: line});
  }

  return nodes.length ? nodes : [{type: 'paragraph', content: ''}];
}

function parseSection(line: string): MarkdownNode | undefined {
  const match = /^(#{1,6})\s+(.*)$/.exec(line);
  if (!match) return;
  return {
    type: 'section',
    marker: match[1],
    content: match[2],
    children: [],
  };
}

function parseListItem(line: string): MarkdownNode | undefined {
  const match = /^((?:[-+*]|\d+[.)]) )(\[(x| )\] )?(.*)$/.exec(line);
  if (!match) return;
  const checked = match[3] === 'x' ? true : match[2] ? false : undefined;
  return {
    type: 'list-item',
    marker: match[1],
    checked,
    children: [{type: 'paragraph', content: match[4]}],
  };
}

function parseBlockQuote(line: string): MarkdownNode | undefined {
  const match = /^(>\s?)(.*)$/.exec(line);
  if (!match) return;
  return {
    type: 'block-quote',
    marker: match[1],
    children: [{type: 'paragraph', content: match[2]}],
  };
}
