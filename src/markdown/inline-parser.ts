import {
  type ParserTree,
  createSyntaxNode,
  createTree,
} from './parser-tree.js';

function parse(text: string, tree?: ParserTree): ParserTree {
  tree?.delete();
  return createTree(createSyntaxNode('text', text));
}

export const parser = {
  parse,
};
