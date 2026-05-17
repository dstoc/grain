import { buildInlineTree } from './build-tree.js';
import type { InlineTree } from './ast.js';
import { resolveDelimiters } from './resolve-delimiters.js';
import { scanInline } from './scanner.js';

export function parse(text: string): InlineTree {
  const scanned = scanInline(text);
  const resolved = resolveDelimiters(scanned);
  return buildInlineTree(text, resolved);
}

export const parser = {
  parse,
};
