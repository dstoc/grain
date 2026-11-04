import { parseBlocks } from '../../../src/markdown/block-parser/api.js';
import type { MarkdownNode } from '../../../src/markdown/node.js';
import { isInlineNode } from '../../../src/markdown/node.js';
import { NativeFixture } from '../../../src/markdown/multiwriter/ownership/test-fixtures.js';
import { openReferenceDocument } from '../../../src/markdown/multiwriter/reference/document.js';
import type { ReferenceGenesis } from '../../../src/markdown/multiwriter/reference/document.js';
import { LocalEditor } from '../../../src/markdown/multiwriter/authoring/index.js';
import { serializeProjection } from '../../../src/markdown/multiwriter/projection/project.js';
import { resourceKey } from '../../../src/markdown/multiwriter/layout/index.js';
import type { ViewNode } from '../../../src/markdown/multiwriter/projection/types.js';
import type { SeedBlock } from '../trace.js';

/** One construction only. Each replica receives detached genesis bytes and descriptors. */
export function commandGenesis(markdown = 'abcdef'): ReferenceGenesis {
  const parsed = parseBlocks(markdown).node,
    blocks: SeedBlock[] = [],
    nodes: { name: string; node: MarkdownNode }[] = [];
  let ordinal = 0;
  const visit = (node: MarkdownNode, parent: string | null) => {
    const name = `n${ordinal++}`,
      inline = isInlineNode(node);
    nodes.push({ name, node });
    blocks.push({
      id: name,
      parent,
      role:
        node.type === 'document'
          ? 'root'
          : inline
            ? 'inline'
            : node.type === 'block-quote'
              ? 'quote'
              : (node.type as 'list' | 'list-item'),
      ...(inline
        ? {
            flow: `${name}:flow`,
            run: `${name}:run`,
            tape: `${name}:tape`,
            cells: [...node.content].map((text, i) => ({ id: `${name}:${i}`, text })),
          }
        : {}),
    });
    for (const child of node.children ?? []) visit(child, name);
  };
  visit(parsed, null);
  const f = new NativeFixture(blocks);
  try {
    return structuredClone({
      documentId: 'D',
      genesisId: 'G',
      layout: f.genesis,
      body: { ...f.bodies.get('G')!, allocations: f.genesis.allocations },
      initialProperties: nodes.map(({ name, node }) => ({
        node: f.id(name, 'node'),
        values: {
          presentation:
            node.type === 'section'
              ? ('section' as const)
              : node.type === 'code-block'
                ? ('code' as const)
                : ('paragraph' as const),
          marker: 'marker' in node ? node.marker : null,
          info: node.type === 'code-block' ? node.info : null,
          checked: node.type === 'list-item' ? (node.checked ?? null) : null,
        },
      })),
    });
  } finally {
    f.destroy();
  }
}
export function commandReplica(genesis: ReferenceGenesis, bytes?: Uint8Array) {
  const document = openReferenceDocument(structuredClone(genesis));
  if (bytes) document.store.applyUpdate(bytes);
  let refresh = document.publication.refresh();
  while (refresh.state === 'deferred') refresh = refresh.continuation.resume();
  const editor = new LocalEditor(document, structuredClone(genesis));
  const view = () => document.publication.status().publication!.value.view;
  const nodes = () => {
    const out: ViewNode[] = [];
    const visit = (n: ViewNode) => {
      if (n.type === 'paragraph' || n.type === 'section' || n.type === 'code-block') out.push(n);
      n.children.forEach(visit);
    };
    visit(view().root);
    return out;
  };
  return {
    genesis,
    document,
    editor,
    view,
    nodes,
    handle: (n: ViewNode) => editor.handle(n.origin.representative),
    markdown: () => serializeProjection(view()),
    receive(bytes: Uint8Array) {
      document.store.applyUpdate(bytes);
      let refresh = document.publication.refresh();
      while (refresh.state === 'deferred') refresh = refresh.continuation.resume();
    },
    observe() {
      const p = document.publication.status().publication!;
      const value = p.value;
      return {
        ready: document.store.snapshot().ready,
        placements: value.ownership.nodeAllocations.map((n) => ({
          node: n.id,
          placement: value.ownership.blockPlacement(n.id),
        })),
        flows: value.ownership.flowPlacements,
        assignments: value.ownership.assignments,
        slots: value.ownership.buckets,
        tree: value.view,
        markdown: serializeProjection(value.view),
        identities: nodes()
          .flatMap((n) =>
            n.fragments
              .filter((f) => f.visible)
              .flatMap((f) =>
                Array.from(
                  { length: f.range.length },
                  (_, i) => `${resourceKey(f.range.tape)}:${f.range.client}:${f.range.clock + i}`,
                ),
              ),
          )
          .sort(),
        native: p.native.encodeState(),
      };
    },
    close() {
      editor.destroy();
      document.destroy();
    },
  };
}
export type CommandReplica = ReturnType<typeof commandReplica>;
