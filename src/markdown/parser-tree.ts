export interface ParserSyntaxNode {
  id: number;
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  namedChildren: ParserSyntaxNode[];
}

export interface ParserTree<Node extends ParserSyntaxNode = ParserSyntaxNode> {
  rootNode: Node;
}

let nextNodeId = 0;

export function createSyntaxNode(
  type: string,
  text: string,
  startIndex = 0,
  namedChildren: ParserSyntaxNode[] = [],
): ParserSyntaxNode {
  return {
    id: nextNodeId++,
    type,
    text,
    startIndex,
    endIndex: startIndex + text.length,
    namedChildren,
  };
}

export function createTree<Node extends ParserSyntaxNode>(
  rootNode: Node,
): ParserTree<Node> {
  return {
    rootNode,
  };
}
