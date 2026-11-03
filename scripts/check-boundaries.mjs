#!/usr/bin/env node

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createScanner, LanguageVariant, SyntaxKind } from 'typescript/unstable/ast';

const repository = process.cwd();
const sourceRoot = path.join(repository, 'src');
const testOnlySources = [
  /^src\/editing\/test\//,
  /^src\/markdown\/block-parser\.permutations\./,
  /^src\/markdown\/inline-parser\/commonmark(?:-|\.)/,
  /^src\/markdown\/canonical-history-capture\.reference\.ts$/,
];
const productionPaths = sourceFiles(sourceRoot).filter((file) => {
  const relative = path.relative(repository, file).split(path.sep).join('/');
  return !file.endsWith('.test.ts') && !testOnlySources.some((pattern) => pattern.test(relative));
});
const productionSet = new Set(productionPaths.map((file) => path.resolve(file)));
const errors = new Set();

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return entry.isFile() && entry.name.endsWith('.ts') ? [absolute] : [];
  });
}

function relativePath(absolute) {
  return path.relative(repository, absolute).split(path.sep).join('/');
}

function tokensIn(source) {
  const scanner = createScanner(true, LanguageVariant.Standard, source);
  const tokens = [];
  const templateExpressionDepths = [];
  let kind = scanner.scan();
  let previous;
  while (kind !== SyntaxKind.EndOfFile) {
    if (kind === SyntaxKind.SlashToken && regexCanStartAfter(previous))
      kind = scanner.reScanSlashToken();
    tokens.push({
      kind,
      text: scanner.getTokenText(),
      value: scanner.getTokenValue(),
      lineBreakBefore: scanner.hasPrecedingLineBreak(),
    });
    if (kind === SyntaxKind.TemplateHead) {
      templateExpressionDepths.push(0);
    } else if (kind === SyntaxKind.OpenBraceToken && templateExpressionDepths.length) {
      templateExpressionDepths[templateExpressionDepths.length - 1]++;
    } else if (kind === SyntaxKind.CloseBraceToken && templateExpressionDepths.length) {
      const index = templateExpressionDepths.length - 1;
      if (templateExpressionDepths[index] > 0) {
        templateExpressionDepths[index]--;
      } else {
        kind = scanner.reScanTemplateToken(false);
        tokens.push({
          kind,
          text: scanner.getTokenText(),
          value: scanner.getTokenValue(),
          lineBreakBefore: scanner.hasPrecedingLineBreak(),
        });
        if (kind === SyntaxKind.TemplateTail) templateExpressionDepths.pop();
        previous = tokens.at(-1);
        kind = scanner.scan();
        continue;
      }
    }
    previous = tokens.at(-1);
    kind = scanner.scan();
  }
  return tokens;
}

function regexCanStartAfter(previous) {
  if (!previous) return true;
  const expressionEnders = new Set([
    SyntaxKind.Identifier,
    SyntaxKind.NumericLiteral,
    SyntaxKind.StringLiteral,
    SyntaxKind.NoSubstitutionTemplateLiteral,
    SyntaxKind.TemplateTail,
    SyntaxKind.CloseParenToken,
    SyntaxKind.CloseBracketToken,
    SyntaxKind.CloseBraceToken,
    SyntaxKind.PlusPlusToken,
    SyntaxKind.MinusMinusToken,
  ]);
  if (!expressionEnders.has(previous.kind)) return true;
  return ['return', 'throw', 'case', 'delete', 'void', 'typeof', 'new', 'yield', 'await'].includes(
    previous.text,
  );
}

function packageName(specifier) {
  if (specifier.startsWith('node:')) return specifier;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function resolveLocalTarget(source, specifier) {
  if (!specifier.startsWith('.')) return undefined;
  const base = path.resolve(path.dirname(path.join(repository, source)), specifier);
  const candidates = [
    base.replace(/\.js$/, '.ts'),
    base,
    `${base}.ts`,
    path.join(base, 'index.ts'),
  ];
  const resolved = candidates.find((candidate) => productionSet.has(path.resolve(candidate)));
  return resolved ? relativePath(resolved) : undefined;
}

function typeModifier(tokens, index) {
  if (tokens[index]?.kind !== SyntaxKind.TypeKeyword) return false;
  const next = tokens[index + 1]?.kind;
  return next !== SyntaxKind.FromKeyword && next !== SyntaxKind.CommaToken;
}

function namedSpecifiersAreTypeOnly(tokens, openIndex, closeIndex) {
  const groups = [];
  let current = [];
  for (let index = openIndex + 1; index < closeIndex; index++) {
    const token = tokens[index];
    if (token.kind === SyntaxKind.CommaToken) {
      if (current.length) groups.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length) groups.push(current);
  return (
    groups.length > 0 &&
    groups.every(
      (group) =>
        group[0]?.kind === SyntaxKind.TypeKeyword &&
        group[1] &&
        group[1].kind !== SyntaxKind.AsKeyword,
    )
  );
}

function findClosingBrace(tokens, openIndex, limit) {
  let depth = 0;
  for (let index = openIndex; index < limit; index++) {
    if (tokens[index].kind === SyntaxKind.OpenBraceToken) depth++;
    if (tokens[index].kind === SyntaxKind.CloseBraceToken && --depth === 0) return index;
  }
  return -1;
}

function staticTypeOnly(tokens, keywordIndex, fromIndex) {
  const first = tokens[keywordIndex + 1];
  if (typeModifier(tokens, keywordIndex + 1)) return true;
  if (first?.kind !== SyntaxKind.OpenBraceToken) return false;
  const closeIndex = findClosingBrace(tokens, keywordIndex + 1, fromIndex);
  if (closeIndex < 0) return false;
  return namedSpecifiersAreTypeOnly(tokens, keywordIndex + 1, closeIndex);
}

function scanEdges(sourcePath, sourceText) {
  const tokens = tokensIn(sourceText);
  const edges = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind !== SyntaxKind.ImportKeyword && token.kind !== SyntaxKind.ExportKeyword)
      continue;
    const isImport = token.kind === SyntaxKind.ImportKeyword;
    const next = tokens[index + 1];

    if (isImport && next?.kind === SyntaxKind.OpenParenToken) {
      const literal = tokens[index + 2];
      const close = tokens[index + 3];
      if (literal?.kind === SyntaxKind.StringLiteral && close?.kind === SyntaxKind.CloseParenToken)
        edges.push(makeEdge(sourcePath, literal.value, false, true));
      continue;
    }

    if (isImport && next?.kind === SyntaxKind.StringLiteral) {
      edges.push(makeEdge(sourcePath, next.value, false, true));
      continue;
    }

    let fromIndex = -1;
    for (let cursor = index + 1; cursor < tokens.length; cursor++) {
      const current = tokens[cursor];
      if (current.kind === SyntaxKind.SemicolonToken) break;
      if (
        (current.kind === SyntaxKind.ImportKeyword || current.kind === SyntaxKind.ExportKeyword) &&
        current.lineBreakBefore
      )
        break;
      if (current.kind === SyntaxKind.FromKeyword) {
        fromIndex = cursor;
        break;
      }
    }
    const specifier = fromIndex >= 0 ? tokens[fromIndex + 1] : undefined;
    if (specifier?.kind !== SyntaxKind.StringLiteral) continue;
    const typeOnly = staticTypeOnly(tokens, index, fromIndex);
    edges.push(makeEdge(sourcePath, specifier.value, typeOnly, !typeOnly));
  }
  return edges;
}

function makeEdge(source, specifier, typeOnly, runtime) {
  const localTarget = resolveLocalTarget(source, specifier);
  const unresolvedLocalTarget = specifier.startsWith('.')
    ? relativePath(
        path.resolve(
          path.dirname(path.join(repository, source)),
          specifier.replace(/\.js$/, '.ts'),
        ),
      )
    : undefined;
  return {
    source,
    specifier,
    localTarget,
    unresolvedLocalTarget,
    typeOnly,
    runtime,
    packageName: specifier.startsWith('.') ? undefined : packageName(specifier),
  };
}

const moduleEdges = new Map();
const allEdges = [];
for (const absolute of productionPaths) {
  const sourcePath = relativePath(absolute);
  const edges = scanEdges(sourcePath, readFileSync(absolute, 'utf8'));
  moduleEdges.set(sourcePath, edges);
  allEdges.push(...edges);
}

function isCanonicalImplementation(file) {
  return (
    file.startsWith('src/markdown/canonical/') || /^src\/markdown\/canonical-[^/]+\.ts$/.test(file)
  );
}

function isParserSemanticOrCommand(file) {
  return (
    file.startsWith('src/markdown/semantic/') ||
    file.startsWith('src/markdown/block-parser/') ||
    file.startsWith('src/markdown/inline-parser/') ||
    file.startsWith('src/editing/commands/') ||
    file.startsWith('src/editing/operations/')
  );
}

function isRenderer(file) {
  if (!file.startsWith('src/markdown/')) return false;
  const name = path.posix.basename(file);
  return /(?:render|block-ui|transclusion|node-view|construction-preview|host-context|node-signal-controller)\.ts$/.test(
    name,
  );
}

function layerForMetrics(file) {
  if (file === 'src/main.ts') return 'host';
  if (file.startsWith('src/editing/')) return 'editing';
  if (isRenderer(file)) return 'rendering';
  if (file.startsWith('src/markdown/semantic/')) return 'semantic';
  if (
    file.startsWith('src/markdown/block-parser/') ||
    file.startsWith('src/markdown/inline-parser/')
  )
    return 'parsing';
  if (isCanonicalImplementation(file) || canonicalCompatibilityFacades.has(file))
    return 'canonical';
  return 'shared';
}

const canonicalCompatibilityFacades = new Set([
  'src/markdown/canonical-actions.ts',
  'src/markdown/canonical-model.ts',
]);

function isCanonicalMutationSurface(file) {
  return isCanonicalImplementation(file) || canonicalCompatibilityFacades.has(file);
}

const retiredPaths = [
  /^src\/editing\/editor\.ts$/,
  /^src\/editing\/edits\//,
  /^src\/editing\/(?:keyboard|block-selection-util|copy-paste-util|block-util|indent-util)\.ts$/,
  /^src\/markdown\/(?:view-model(?:-.*)?|normalize|semantic-normalize|canonical-normalize|semantic-tree-draft)\.ts$/,
];

function directEdgeViolations(edge) {
  const target = edge.localTarget ?? edge.unresolvedLocalTarget;
  if (!target) return [];
  const violations = [];
  if (isParserSemanticOrCommand(edge.source) && isCanonicalImplementation(target))
    violations.push(`${edge.source} depends on canonical implementation ${target}`);
  if (isCanonicalImplementation(edge.source) && canonicalCompatibilityFacades.has(target))
    violations.push(`${edge.source} imports compatibility facade ${target}`);
  if (isRenderer(edge.source) && isCanonicalMutationSurface(target))
    violations.push(`${edge.source} depends on canonical mutation surface ${target}`);
  if (retiredPaths.some((pattern) => pattern.test(target)))
    violations.push(`${edge.source} imports retired path ${target}`);
  return violations;
}

function reachable(root, visit) {
  const pending = [root];
  const seen = new Set();
  while (pending.length) {
    const current = pending.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    visit(current);
    pending.push(
      ...(moduleEdges.get(current) ?? []).flatMap((edge) =>
        edge.localTarget ? [edge.localTarget] : [],
      ),
    );
  }
}

for (const edge of allEdges) {
  for (const violation of directEdgeViolations(edge)) errors.add(violation);
}

const parserCoreRoots = [
  'src/markdown/block-parser/api.ts',
  'src/markdown/inline-parser/index.ts',
  'src/markdown/node.ts',
  'src/markdown/block-serializer.ts',
  'src/markdown/semantic/construction-tree.ts',
];
const prohibitedParserPackages = new Set(['lit', '@lit/context', 'yjs']);
for (const root of [...moduleEdges.keys()].filter(isRenderer)) {
  reachable(root, (current) => {
    for (const edge of moduleEdges.get(current) ?? []) {
      if (edge.localTarget && isCanonicalMutationSurface(edge.localTarget))
        errors.add(
          `${root} depends on canonical mutation surface ${edge.localTarget} through ${current}`,
        );
    }
  });
}

const rendererPattern =
  /^src\/(?:editing\/(?:canonical-editor|mobile-keyboard-toolbar)\.ts|main\.ts|markdown\/(?:[^/]*render|block-ui|transclusion|host-context|node-signal-controller)\.ts)$/;
for (const root of [...moduleEdges.keys()].filter(isCanonicalImplementation)) {
  reachable(root, (current) => {
    if (rendererPattern.test(current))
      errors.add(`${root} depends on browser renderer/editor module ${current}`);
  });
}

const browserGlobals = new Set([
  'window',
  'document',
  'navigator',
  'location',
  'customElements',
  'HTMLElement',
  'HTMLDocument',
  'HTMLCanvasElement',
  'Element',
  'ShadowRoot',
  'Document',
  'Window',
  'Event',
  'CustomEvent',
  'EventTarget',
  'MutationObserver',
  'ResizeObserver',
  'IntersectionObserver',
  'Selection',
  'Range',
  'ClipboardEvent',
  'InputEvent',
  'MouseEvent',
  'KeyboardEvent',
  'DocumentFragment',
  'DocumentType',
  'NodeFilter',
  'CSSStyleSheet',
]);

function checkBrowserGlobals(sourcePath, sourceText) {
  const tokens = tokensIn(sourceText);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind !== SyntaxKind.Identifier || !browserGlobals.has(token.text)) continue;
    const previous = tokens[index - 1]?.kind;
    const next = tokens[index + 1]?.kind;
    if (
      previous === SyntaxKind.DotToken ||
      previous === SyntaxKind.QuestionDotToken ||
      next === SyntaxKind.ColonToken
    )
      continue;
    errors.add(`${sourcePath} uses browser global ${token.text}`);
  }
}

for (const absolute of productionPaths) {
  const sourcePath = relativePath(absolute);
  if (isParserSemanticOrCommand(sourcePath))
    checkBrowserGlobals(sourcePath, readFileSync(absolute, 'utf8'));
}

for (const root of parserCoreRoots) {
  if (!moduleEdges.has(root)) continue;
  reachable(root, (current) => {
    if (isCanonicalImplementation(current))
      errors.add(`${root} depends on canonical implementation ${current}`);
    checkBrowserGlobals(current, readFileSync(path.join(repository, current), 'utf8'));
    for (const edge of moduleEdges.get(current) ?? []) {
      if (edge.packageName && prohibitedParserPackages.has(edge.packageName))
        errors.add(`${root} loads ${edge.packageName} through ${current}`);
    }
  });
}

function runtimeCycleCount() {
  const runtimeAdjacency = new Map(
    [...moduleEdges].map(([source, edges]) => [
      source,
      edges.flatMap((edge) => (edge.runtime && edge.localTarget ? [edge.localTarget] : [])),
    ]),
  );
  let nextIndex = 0;
  const indices = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  let count = 0;

  function connect(node) {
    indices.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex++;
    stack.push(node);
    onStack.add(node);
    for (const target of runtimeAdjacency.get(node) ?? []) {
      if (!indices.has(target)) {
        connect(target);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(target)));
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(target)));
      }
    }
    if (lowLinks.get(node) !== indices.get(node)) return;
    const component = [];
    let member;
    do {
      member = stack.pop();
      onStack.delete(member);
      component.push(member);
    } while (member !== node);
    if (component.length > 1 || (runtimeAdjacency.get(node) ?? []).includes(node)) count++;
  }

  for (const node of runtimeAdjacency.keys()) if (!indices.has(node)) connect(node);
  return count;
}

function verifyTypeOnlyRules() {
  const sourcePath = 'src/editing/commands/type-only-policy-smoke.ts';
  const edges = scanEdges(
    sourcePath,
    "import type { NodeId } from '../../markdown/canonical/document.js';\nexport type { NodeId } from '../../markdown/canonical/document.js';",
  );
  if (
    edges.length !== 2 ||
    !edges.every((edge) => edge.typeOnly && directEdgeViolations(edge).length > 0 && !edge.runtime)
  )
    throw new Error('boundary policy self-check failed to reject type-only imports and re-exports');
}

verifyTypeOnlyRules();

const runtimeCycles = runtimeCycleCount();
if (runtimeCycles !== 0) errors.add(`found ${runtimeCycles} runtime dependency cycle(s)`);
for (const error of [...errors].sort()) process.stderr.write(`boundary: ${error}\n`);

const typeOnlyEdgeCount = allEdges.filter((edge) => edge.typeOnly).length;
const externalEdgeCount = allEdges.filter((edge) => edge.packageName).length;
const layerCounts = Object.fromEntries(
  [...moduleEdges.keys()].reduce((counts, file) => {
    const layer = layerForMetrics(file);
    counts.set(layer, (counts.get(layer) ?? 0) + 1);
    return counts;
  }, new Map()),
);
process.stdout.write(
  `Boundary check: ${productionPaths.length} production modules, ${allEdges.length} static import/re-export/dynamic edges (${typeOnlyEdgeCount} type-only, ${externalEdgeCount} external), ${runtimeCycles} runtime cycles; type-only policy self-check passed.\n`,
);
process.stdout.write(`Modules by layer: ${JSON.stringify(layerCounts)}.\n`);
if (errors.size) process.exitCode = 1;
