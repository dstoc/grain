export interface ParserPosition {
  row: number;
  column: number;
}

export interface ParserEdit {
  startIndex: number;
  oldEndIndex: number;
  newEndIndex: number;
  startPosition?: ParserPosition;
  oldEndPosition?: ParserPosition;
  newEndPosition?: ParserPosition;
  newText?: string;
}

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
  edit(edit: ParserEdit): void;
  delete(): void;
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
    edit() {},
    delete() {},
  };
}
