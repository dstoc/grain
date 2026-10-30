import type {
  ResolvedImage,
  ResolvedInline,
  ResolvedInlineLink,
  ResolvedShortcutLink,
  SyntaxToken,
} from './types.js';

interface LinkOpener {
  index: number;
  imageMarkerIndex: number | null;
}

interface ParsedSpan {
  text: string;
  startIndex: number;
  endIndex: number;
}

interface ParsedLinkTail {
  endTokenIndex: number;
  destination: ParsedSpan;
  title?: ParsedSpan;
}

interface ParsedTitle extends ParsedSpan {
  nextIndex: number;
}

interface ResolvedStructure {
  node: ResolvedInline;
  startTokenIndex: number;
  endTokenIndex: number;
}

export function resolveLinksAndImages(resolved: ResolvedInline[]): ResolvedInline[] {
  const openers: LinkOpener[] = [];
  const structures = new Map<number, ResolvedStructure>();
  const consumed = new Set<number>();

  for (let index = 0; index < resolved.length; index += 1) {
    if (consumed.has(index)) {
      continue;
    }

    const token = resolved[index];
    if (isBracketOpen(token)) {
      openers.push({
        index,
        imageMarkerIndex: getImageMarkerIndex(resolved, index, consumed),
      });
      continue;
    }

    if (!isBracketClose(token) || openers.length === 0) {
      continue;
    }

    const tailStartIndex = index + 1;
    const hasExplicitTail = hasParenOpen(resolved, tailStartIndex, consumed);
    const parsedTail = hasExplicitTail ? parseLinkTail(resolved, tailStartIndex) : null;

    if (hasExplicitTail && parsedTail === null) {
      continue;
    }

    for (let openerIndex = openers.length - 1; openerIndex >= 0; openerIndex -= 1) {
      const opener = openers[openerIndex];
      if (consumed.has(opener.index)) {
        continue;
      }

      if (hasExplicitTail) {
        const node = createExplicitNode(resolved, opener, index, parsedTail!);
        if (node === null) {
          continue;
        }

        const startTokenIndex = opener.imageMarkerIndex ?? opener.index;
        const endTokenIndex = parsedTail!.endTokenIndex;
        consumeRange(consumed, startTokenIndex, endTokenIndex);
        structures.set(startTokenIndex, {
          node,
          startTokenIndex,
          endTokenIndex,
        });
        openers.splice(openerIndex);
        break;
      }

      if (opener.imageMarkerIndex !== null) {
        continue;
      }

      const node = createShortcutNode(resolved, opener, index);
      if (node === null) {
        continue;
      }

      consumeRange(consumed, opener.index, index);
      structures.set(opener.index, {
        node,
        startTokenIndex: opener.index,
        endTokenIndex: index,
      });
      openers.splice(openerIndex);
      break;
    }
  }

  const output: ResolvedInline[] = [];
  for (let index = 0; index < resolved.length; index += 1) {
    const structured = structures.get(index);
    if (structured !== undefined) {
      output.push(structured.node);
      index = structured.endTokenIndex;
      continue;
    }

    if (consumed.has(index)) {
      continue;
    }

    output.push(resolved[index]);
  }

  return output;
}

function createShortcutNode(
  resolved: ResolvedInline[],
  opener: LinkOpener,
  closerIndex: number,
): ResolvedShortcutLink {
  return {
    type: 'shortcut_link',
    text: joinTokenText(resolved.slice(opener.index, closerIndex + 1)),
    startIndex: resolved[opener.index].startIndex,
    endIndex: resolved[closerIndex].endIndex,
    label: resolved.slice(opener.index + 1, closerIndex),
  };
}

function createExplicitNode(
  resolved: ResolvedInline[],
  opener: LinkOpener,
  closerIndex: number,
  parsedTail: ParsedLinkTail,
): ResolvedInlineLink | ResolvedImage | null {
  const startTokenIndex = opener.imageMarkerIndex ?? opener.index;
  const label = resolved.slice(opener.index + 1, closerIndex);
  const text = joinTokenText(resolved.slice(startTokenIndex, parsedTail.endTokenIndex + 1));

  const common = {
    text,
    startIndex: resolved[startTokenIndex].startIndex,
    endIndex: resolved[parsedTail.endTokenIndex].endIndex,
    label,
    destination: parsedTail.destination.text,
    destinationStartIndex: parsedTail.destination.startIndex,
    destinationEndIndex: parsedTail.destination.endIndex,
  };

  if (opener.imageMarkerIndex !== null) {
    return parsedTail.title === undefined
      ? {
          type: 'image',
          ...common,
        }
      : {
          type: 'image',
          ...common,
          title: parsedTail.title.text,
          titleStartIndex: parsedTail.title.startIndex,
          titleEndIndex: parsedTail.title.endIndex,
        };
  }

  return parsedTail.title === undefined
    ? {
        type: 'inline_link',
        ...common,
      }
    : {
        type: 'inline_link',
        ...common,
        title: parsedTail.title.text,
        titleStartIndex: parsedTail.title.startIndex,
        titleEndIndex: parsedTail.title.endIndex,
      };
}

function parseLinkTail(resolved: ResolvedInline[], startIndex: number): ParsedLinkTail | null {
  const tail = resolved.slice(startIndex);
  if (tail.length === 0 || !isParenOpen(tail[0])) {
    return null;
  }

  const text = joinTokenText(tail);
  const tokenOffsets = createTokenOffsets(tail);
  let cursor = 1;

  cursor = skipWhitespace(text, cursor);
  const destination = parseDestination(text, cursor);
  if (destination === null) {
    return null;
  }

  cursor = destination.endIndex;
  cursor = skipWhitespace(text, cursor);

  let title: ParsedTitle | undefined;
  if (cursor < text.length && isTitleDelimiter(text[cursor])) {
    const parsedTitle = parseTitle(text, cursor);
    if (parsedTitle === null) {
      return null;
    }
    title = parsedTitle;
    cursor = parsedTitle.nextIndex;
    cursor = skipWhitespace(text, cursor);
  }

  if (cursor >= text.length || text[cursor] !== ')') {
    return null;
  }

  const closeTokenIndex = offsetToTokenIndex(tokenOffsets, cursor, tail);
  if (closeTokenIndex === -1) {
    return null;
  }

  return {
    endTokenIndex: startIndex + closeTokenIndex,
    destination: mapSpanToSource(destination, tail, tokenOffsets),
    title: title === undefined ? undefined : mapSpanToSource(title, tail, tokenOffsets),
  };
}

function parseDestination(text: string, startIndex: number): ParsedSpan | null {
  let cursor = startIndex;

  if (cursor >= text.length) {
    return {
      text: '',
      startIndex: cursor,
      endIndex: cursor,
    };
  }

  if (text[cursor] === '<') {
    const closeIndex = text.indexOf('>', cursor + 1);
    if (closeIndex === -1) {
      return null;
    }

    return {
      text: text.slice(cursor + 1, closeIndex),
      startIndex: cursor + 1,
      endIndex: closeIndex,
    };
  }

  let depth = 0;
  while (cursor < text.length) {
    const char = text[cursor];
    if (char === '\\' && cursor + 1 < text.length) {
      cursor += 2;
      continue;
    }
    if (char === '(') {
      depth += 1;
      cursor += 1;
      continue;
    }
    if (char === ')') {
      if (depth === 0) {
        break;
      }
      depth -= 1;
      cursor += 1;
      continue;
    }
    if (isWhitespace(char) && depth === 0) {
      break;
    }
    cursor += 1;
  }

  return {
    text: text.slice(startIndex, cursor),
    startIndex,
    endIndex: cursor,
  };
}

function parseTitle(text: string, startIndex: number): ParsedTitle | null {
  const delimiter = text[startIndex];
  let cursor = startIndex + 1;
  let depth = 0;

  while (cursor < text.length) {
    const char = text[cursor];
    if (char === '\\' && cursor + 1 < text.length) {
      cursor += 2;
      continue;
    }
    if (delimiter === '(') {
      if (char === '(') {
        depth += 1;
        cursor += 1;
        continue;
      }
      if (char === ')') {
        if (depth === 0) {
          break;
        }
        depth -= 1;
        cursor += 1;
        continue;
      }
    } else if (char === delimiter) {
      break;
    }
    cursor += 1;
  }

  if (cursor >= text.length) {
    return null;
  }

  return {
    text: text.slice(startIndex + 1, cursor),
    startIndex: startIndex + 1,
    endIndex: cursor,
    nextIndex: cursor + 1,
  };
}

function mapSpanToSource(
  span: ParsedSpan,
  tail: ResolvedInline[],
  tokenOffsets: number[],
): ParsedSpan {
  return {
    text: span.text,
    startIndex: offsetToSourceIndex(tail, tokenOffsets, span.startIndex),
    endIndex: offsetToSourceIndex(tail, tokenOffsets, span.endIndex),
  };
}

function createTokenOffsets(tokens: ResolvedInline[]): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const token of tokens) {
    offsets.push(offset);
    offset += token.text.length;
  }
  return offsets;
}

function offsetToSourceIndex(
  tokens: ResolvedInline[],
  tokenOffsets: number[],
  offset: number,
): number {
  for (let index = 0; index < tokenOffsets.length; index += 1) {
    const tokenStart = tokenOffsets[index];
    const tokenEnd = tokenStart + tokens[index].text.length;
    if (offset < tokenEnd) {
      return tokens[index].startIndex + (offset - tokenStart);
    }
    if (offset === tokenEnd) {
      return tokens[index].endIndex;
    }
  }
  return tokens[tokens.length - 1].endIndex;
}

function offsetToTokenIndex(
  tokenOffsets: number[],
  offset: number,
  tokens: ResolvedInline[],
): number {
  for (let index = 0; index < tokenOffsets.length; index += 1) {
    const tokenStart = tokenOffsets[index];
    const tokenEnd = tokenStart + tokens[index].text.length;
    if (offset >= tokenStart && offset < tokenEnd) {
      return index;
    }
    if (offset === tokenEnd && tokens[index].text.length === 0) {
      return index;
    }
  }
  return -1;
}

function consumeRange(consumed: Set<number>, startIndex: number, endIndex: number): void {
  for (let index = startIndex; index <= endIndex; index += 1) {
    consumed.add(index);
  }
}

function getImageMarkerIndex(
  resolved: ResolvedInline[],
  index: number,
  consumed: Set<number>,
): number | null {
  if (index === 0) {
    return null;
  }

  const previous = resolved[index - 1];
  if (!isImageMarker(previous) || consumed.has(index - 1)) {
    return null;
  }

  return index - 1;
}

function hasParenOpen(resolved: ResolvedInline[], index: number, consumed: Set<number>): boolean {
  return index < resolved.length && !consumed.has(index) && isParenOpen(resolved[index]);
}

function joinTokenText(tokens: ResolvedInline[]): string {
  return tokens.map((token) => token.text).join('');
}

function skipWhitespace(text: string, startIndex: number): number {
  let cursor = startIndex;
  while (cursor < text.length && isWhitespace(text[cursor])) {
    cursor += 1;
  }
  return cursor;
}

function isBracketOpen(token: ResolvedInline): token is SyntaxToken {
  return token.type === 'syntax' && token.kind === 'bracket_open';
}

function isBracketClose(token: ResolvedInline): token is SyntaxToken {
  return token.type === 'syntax' && token.kind === 'bracket_close';
}

function isParenOpen(token: ResolvedInline): token is SyntaxToken {
  return token.type === 'syntax' && token.kind === 'paren_open';
}

function isImageMarker(token: ResolvedInline): token is SyntaxToken {
  return token.type === 'syntax' && token.kind === 'image_marker';
}

function isTitleDelimiter(char: string): char is '"' | "'" | '(' {
  return char === '"' || char === "'" || char === '(';
}

function isWhitespace(char: string): boolean {
  return /\s/u.test(char);
}
