import type {
  InlineToken,
  ResolvedCodeSpan,
  ResolvedDelimitedBase,
  ResolvedEmphasis,
  ResolvedInline,
  ResolvedStrikethrough,
  ResolvedStrongEmphasis,
  SyntaxToken,
} from './types.js';
import { resolveLinksAndImages } from './links.js';

export function resolveDelimiters(tokens: InlineToken[]): ResolvedInline[] {
  return resolveInlineStructure(resolveCodeSpans(tokens));
}

function resolveInlineStructure(tokens: ResolvedInline[]): ResolvedInline[] {
  return resolveLinksAndImages(resolveDelimitedRuns(tokens));
}

function resolveCodeSpans(tokens: InlineToken[]): ResolvedInline[] {
  const openers: { index: number; token: SyntaxToken }[] = [];
  const pairs = new Map<number, number>();
  const pairedClosers = new Set<number>();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!isCodeSpanDelimiter(token)) {
      continue;
    }

    const openerIndex = findLastMatchingOpener(openers, token.length);
    if (openerIndex === -1) {
      openers.push({ index, token });
      continue;
    }

    const opener = openers[openerIndex];
    openers.splice(openerIndex);
    pairs.set(opener.index, index);
    pairedClosers.add(index);
  }

  const resolved: ResolvedInline[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const closerIndex = pairs.get(index);
    if (closerIndex !== undefined && isCodeSpanDelimiter(token)) {
      resolved.push(createCodeSpan(tokens, index, closerIndex));
      index = closerIndex;
      continue;
    }

    if (pairedClosers.has(index)) {
      continue;
    }

    resolved.push(token);
  }

  return resolved;
}

function resolveDelimitedRuns(tokens: ResolvedInline[]): ResolvedInline[] {
  const openers = new Map<string, { index: number; token: SyntaxToken }[]>();
  const pairs = new Map<number, number>();
  const pairedClosers = new Set<number>();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!isDelimitedToken(token)) {
      continue;
    }

    const key = delimiterKey(token);
    const openersForKey = openers.get(key);
    if (openersForKey === undefined || openersForKey.length === 0) {
      openers.set(key, [{ index, token }]);
      continue;
    }

    const opener = openersForKey[openersForKey.length - 1];
    if (
      !isValidDelimitedPair(opener.token, token) ||
      index - opener.index <= 1
    ) {
      openersForKey.push({ index, token });
      continue;
    }

    openersForKey.pop();
    pairs.set(opener.index, index);
    pairedClosers.add(index);
  }

  const resolved: ResolvedInline[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const closerIndex = pairs.get(index);
    if (closerIndex !== undefined && isDelimitedToken(token)) {
      resolved.push(createDelimitedNode(tokens, index, closerIndex));
      index = closerIndex;
      continue;
    }

    if (pairedClosers.has(index)) {
      continue;
    }

    resolved.push(token);
  }

  return resolved;
}

function isCodeSpanDelimiter(token: InlineToken): token is SyntaxToken {
  return token.type === 'syntax' && token.kind === 'code_span_delimiter';
}

function isDelimitedToken(token: ResolvedInline): token is SyntaxToken {
  return token.type === 'syntax' && token.kind === 'delimiter';
}

function isValidDelimitedPair(
  opener: SyntaxToken,
  closer: SyntaxToken,
): boolean {
  if (opener.marker !== closer.marker || opener.length !== closer.length) {
    return false;
  }

  if (opener.length === 1 || opener.length === 2) {
    return opener.marker !== '~' || opener.length === 2;
  }

  return false;
}

function delimiterKey(token: SyntaxToken): string {
  return `${token.marker}:${token.length}`;
}

function findLastMatchingOpener(
  openers: { index: number; token: SyntaxToken }[],
  length: number,
): number {
  for (let index = openers.length - 1; index >= 0; index -= 1) {
    if (openers[index].token.length === length) {
      return index;
    }
  }
  return -1;
}

function createDelimitedNode(
  tokens: ResolvedInline[],
  openerIndex: number,
  closerIndex: number,
): ResolvedEmphasis | ResolvedStrongEmphasis | ResolvedStrikethrough {
  const opener = tokens[openerIndex] as SyntaxToken;
  const closer = tokens[closerIndex] as SyntaxToken;
  const innerTokens = tokens.slice(openerIndex + 1, closerIndex);
  const children = resolveInlineStructure(innerTokens);
  const text = tokens
    .slice(openerIndex, closerIndex + 1)
    .map((token) => token.text)
    .join('');

  const common: ResolvedDelimitedBase = {
    text,
    startIndex: opener.startIndex,
    endIndex: closer.endIndex,
    children,
  };

  if (opener.marker === '~') {
    return {
      type: 'strikethrough',
      ...common,
    };
  }

  if (opener.length === 2) {
    return {
      type: 'strong_emphasis',
      ...common,
    };
  }

  return {
    type: 'emphasis',
    ...common,
  };
}

function createCodeSpan(
  tokens: InlineToken[],
  openerIndex: number,
  closerIndex: number,
): ResolvedCodeSpan {
  const opener = tokens[openerIndex];
  const closer = tokens[closerIndex];
  const innerTokens = tokens.slice(openerIndex + 1, closerIndex);
  const innerText = innerTokens.map((token) => token.text).join('');

  return {
    type: 'code_span',
    text: tokens
      .slice(openerIndex, closerIndex + 1)
      .map((token) => token.text)
      .join(''),
    startIndex: opener.startIndex,
    endIndex: closer.endIndex,
    innerText,
    innerStartIndex: opener.endIndex,
    innerEndIndex: closer.startIndex,
  };
}
