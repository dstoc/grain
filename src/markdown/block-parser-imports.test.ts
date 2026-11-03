// @ts-expect-error Node APIs are supplied by Vitest; Grain intentionally has no @types/node dependency.
import { readFileSync, existsSync } from 'node:fs';
// @ts-expect-error Node APIs are supplied by Vitest; Grain intentionally has no @types/node dependency.
import { dirname, resolve, join, relative } from 'node:path';
import { expect, test } from 'vitest';

const projectRoot = decodeURIComponent(new URL('../../', import.meta.url).pathname);
const parserEntry = decodeURIComponent(new URL('./block-parser/api.ts', import.meta.url).pathname);
const importPattern =
  /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g;

test('the parser import graph stays free of Lit and Yjs', () => {
  const pending = [parserEntry];
  const visited = new Set<string>();
  const prohibited: string[] = [];

  while (pending.length) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);

    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2] ?? match[3]!;
      if (specifier === 'lit' || specifier === 'yjs' || specifier.startsWith('@lit/')) {
        prohibited.push(`${relative(projectRoot, file)} imports ${specifier}`);
      }
      if (!specifier.startsWith('.')) continue;

      const base = resolve(dirname(file), specifier.replace(/\.js$/, '.ts'));
      const resolved = [base, join(base, 'index.ts')].find(existsSync);
      expect(
        resolved,
        `${relative(projectRoot, file)} imports missing module ${specifier}`,
      ).toBeDefined();
      if (resolved) pending.push(resolved);
    }
  }

  expect(prohibited).toEqual([]);
});
