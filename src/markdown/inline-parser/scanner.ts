import type {
  InlineToken,
  SyntaxToken,
  SyntaxTokenKind,
  TagToken,
  TextToken,
  UriAutolinkToken,
} from './types.js';

export function scanInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let textStart = 0;

  for (let index = 0; index < text.length; ) {
    const char = text[index];

    if (char === '[' || char === ']' || char === '(' || char === ')') {
      pushTextToken(tokens, text, textStart, index);
      tokens.push(
        createSyntaxToken(text, index, char, charToSyntaxKind(char), 1),
      );
      index += 1;
      textStart = index;
      continue;
    }

    if (char === '!' && text[index + 1] === '[') {
      pushTextToken(tokens, text, textStart, index);
      tokens.push(createSyntaxToken(text, index, char, 'image_marker', 1));
      index += 1;
      textStart = index;
      continue;
    }

    if (char === '*' || char === '_' || char === '~') {
      const runEnd = scanRepeatedRun(text, index, char);
      pushTextToken(tokens, text, textStart, index);
      tokens.push(
        createSyntaxToken(text, index, char, 'delimiter', runEnd - index),
      );
      index = runEnd;
      textStart = index;
      continue;
    }

    if (char === '`') {
      const runEnd = scanRepeatedRun(text, index, char);
      pushTextToken(tokens, text, textStart, index);
      tokens.push(
        createSyntaxToken(
          text,
          index,
          char,
          'code_span_delimiter',
          runEnd - index,
        ),
      );
      index = runEnd;
      textStart = index;
      continue;
    }

    if (char === '#') {
      const tagEnd = scanTag(text, index);
      if (tagEnd > index + 1) {
        pushTextToken(tokens, text, textStart, index);
        const tagName = text.slice(index + 1, tagEnd);
        tokens.push(createTagToken(text, index, tagName, tagEnd));
        index = tagEnd;
        textStart = index;
        continue;
      }
    }

    if (char === '<') {
      const uriAutolinkEnd = scanUriAutolink(text, index);
      if (uriAutolinkEnd !== -1) {
        pushTextToken(tokens, text, textStart, index);
        const url = text.slice(index + 1, uriAutolinkEnd - 1);
        tokens.push(createUriAutolinkToken(text, index, url, uriAutolinkEnd));
        index = uriAutolinkEnd;
        textStart = index;
        continue;
      }
    }

    index += 1;
  }

  pushTextToken(tokens, text, textStart, text.length);
  return tokens;
}

function pushTextToken(
  tokens: InlineToken[],
  text: string,
  startIndex: number,
  endIndex: number,
): void {
  if (endIndex <= startIndex) {
    return;
  }

  tokens.push({
    type: 'text',
    text: text.slice(startIndex, endIndex),
    startIndex,
    endIndex,
  } satisfies TextToken);
}

function createSyntaxToken(
  text: string,
  startIndex: number,
  marker: string,
  kind: SyntaxTokenKind,
  length: number,
): SyntaxToken {
  return {
    type: 'syntax',
    kind,
    marker,
    length,
    text: text.slice(startIndex, startIndex + length),
    startIndex,
    endIndex: startIndex + length,
  };
}

function createTagToken(
  text: string,
  startIndex: number,
  tagName: string,
  endIndex: number,
): TagToken {
  return {
    type: 'tag',
    tagName,
    text: text.slice(startIndex, endIndex),
    startIndex,
    endIndex,
  };
}

function createUriAutolinkToken(
  text: string,
  startIndex: number,
  url: string,
  endIndex: number,
): UriAutolinkToken {
  return {
    type: 'uri_autolink',
    url,
    text: text.slice(startIndex, endIndex),
    startIndex,
    endIndex,
  };
}

function charToSyntaxKind(char: string): SyntaxTokenKind {
  switch (char) {
    case '[':
      return 'bracket_open';
    case ']':
      return 'bracket_close';
    case '(':
      return 'paren_open';
    case ')':
      return 'paren_close';
    default:
      return 'delimiter';
  }
}

function scanRepeatedRun(
  text: string,
  startIndex: number,
  marker: string,
): number {
  let endIndex = startIndex + 1;
  while (endIndex < text.length && text[endIndex] === marker) {
    endIndex += 1;
  }
  return endIndex;
}

function scanTag(text: string, startIndex: number): number {
  const first = readCodePoint(text, startIndex + 1);
  if (first === null || !isTagFirstChar(first.char)) {
    return -1;
  }

  let index = first.nextIndex;
  while (index < text.length) {
    const next = readCodePoint(text, index);
    if (next === null || !isTagChar(next.char)) {
      break;
    }
    index = next.nextIndex;
  }

  return index;
}

function scanUriAutolink(text: string, startIndex: number): number {
  const closeIndex = text.indexOf('>', startIndex + 1);
  if (closeIndex === -1) {
    return -1;
  }

  const inner = text.slice(startIndex + 1, closeIndex);
  if (!isUriAutolink(inner)) {
    return -1;
  }

  return closeIndex + 1;
}

function isTagFirstChar(char: string): boolean {
  return /[\p{Letter}\p{Mark}\p{Symbol}]/u.test(char);
}

function isTagChar(char: string): boolean {
  return /[\p{Letter}\p{Number}\p{Mark}\p{Symbol}_/-]/u.test(char);
}

function isUriAutolink(inner: string): boolean {
  if (inner.length === 0 || /[\s<>]/u.test(inner)) {
    return false;
  }

  return /^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>]+$/u.test(inner);
}

function readCodePoint(
  text: string,
  index: number,
): { char: string; nextIndex: number } | null {
  const codePoint = text.codePointAt(index);
  if (codePoint === undefined) {
    return null;
  }

  const char = String.fromCodePoint(codePoint);
  return {
    char,
    nextIndex: index + char.length,
  };
}
