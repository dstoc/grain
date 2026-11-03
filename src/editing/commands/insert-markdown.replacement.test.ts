import { afterEach, expect, it, vi } from 'vitest';

import { CanonicalDocument, type CanonicalNode } from '../../markdown/canonical-model.js';
import { CanonicalWriter } from '../../markdown/canonical-actions.js';
import { resolveCanonicalTextAnchor } from '../../markdown/canonical-selection.js';
import type { BlockSelection } from '../../markdown/semantic/selection.js';
import { runCommand } from '../test/run-command.js';
import { insertMarkdown } from './insert-markdown.js';

const open: { readonly document: CanonicalDocument; readonly writer: CanonicalWriter }[] = [];

afterEach(() => {
  for (const { writer, document } of open.splice(0)) {
    writer.close();
    document.close();
  }
});

function create(markdown: string) {
  const document = CanonicalDocument.fromMarkdown(markdown);
  const writer = new CanonicalWriter(document);
  open.push({ document, writer });
  return { document, writer };
}

function walk(node: CanonicalNode): CanonicalNode[] {
  return [node, ...node.children.flatMap(walk)];
}

function findContent(document: CanonicalDocument, content: string): CanonicalNode {
  const node = walk(document.root).find((candidate) => candidate.content === content);
  if (!node) throw new Error(`missing inline node ${content}`);
  return node;
}

function blockSelection(nodes: readonly CanonicalNode[], reverse = false): BlockSelection {
  const first = nodes[0]!;
  const last = nodes.at(-1)!;
  return {
    nodeIds: nodes.map((node) => node.sharedId),
    anchor: {
      nodeId: reverse ? last.sharedId : first.sharedId,
      offset: reverse ? (last.content ?? '').length : 0,
      affinity: reverse ? 'right' : 'left',
    },
    focus: {
      nodeId: reverse ? first.sharedId : last.sharedId,
      offset: reverse ? 0 : (last.content ?? '').length,
      affinity: reverse ? 'left' : 'right',
    },
  };
}

it.each([false, true])(
  'replaces selected sibling blocks and restores %s-direction history',
  (reverse) => {
    const { document, writer } = create('Alpha\n\nBeta\n\nGamma\n\nDelta');
    const alpha = findContent(document, 'Alpha');
    const beta = findContent(document, 'Beta');
    const gamma = findContent(document, 'Gamma');
    const delta = findContent(document, 'Delta');
    const before = document.exportMarkdownTree();
    const selected = reverse ? [gamma, beta] : [beta, gamma];
    const selection = blockSelection([beta, gamma], reverse);

    const accepted = runCommand(
      writer,
      { actionId: `replace-siblings-${reverse}` },
      document.root.sharedId,
      selection,
      insertMarkdown,
      { contextId: reverse ? beta.sharedId : gamma.sharedId, markdown: 'Alpha' },
    );

    expect(accepted).toBeDefined();
    expect(document.root.children.map((node) => node.content)).toEqual(['Alpha', 'Alpha', 'Delta']);
    expect(document.root.children[0]).toBe(alpha);
    expect(document.root.children[2]).toBe(delta);
    expect(selected.every((node) => !node.connected)).toBe(true);
    expect(document.validate().valid).toBe(true);
    const after = document.exportMarkdownTree();

    const undo = writer.undo();
    expect(undo.status).toBe('applied');
    expect(document.exportMarkdownTree()).toEqual(before);
    expect(resolveCanonicalTextAnchor(document, undo.selectionAnchors!.anchor)).toMatchObject({
      nodeId: reverse ? gamma.sharedId : beta.sharedId,
      offset: reverse ? 5 : 0,
    });
    expect(resolveCanonicalTextAnchor(document, undo.selectionAnchors!.focus)).toMatchObject({
      nodeId: reverse ? beta.sharedId : gamma.sharedId,
      offset: reverse ? 0 : 5,
    });

    const redo = writer.redo();
    expect(redo.status).toBe('applied');
    expect(document.exportMarkdownTree()).toEqual(after);
    expect(redo.focusAnchor?.bookmark.offset ?? redo.focus?.offset).toBe(5);
    expect(document.validate().valid).toBe(true);
  },
);

it.each([0, 1, 2])(
  'keeps list item identity and task state when replacing child position %i',
  (index) => {
    const document = CanonicalDocument.fromTree({
      type: 'document',
      children: [
        {
          type: 'list',
          children: [
            {
              type: 'list-item',
              marker: '* ',
              checked: true,
              children: [
                { type: 'paragraph', content: 'Before' },
                { type: 'paragraph', content: 'Selected' },
                { type: 'paragraph', content: 'After' },
              ],
            },
            { type: 'list-item', marker: '* ', children: [{ type: 'paragraph', content: 'Tail' }] },
          ],
        },
      ],
    });
    const writer = new CanonicalWriter(document);
    open.push({ document, writer });
    const list = document.root.children[0]!;
    const item = list.children[0]!;
    const tailItem = list.children[1]!;
    const selected = item.children[index]!;
    const untouched = item.children.filter((node) => node !== selected);
    const before = document.exportMarkdownTree();

    const accepted = runCommand(
      writer,
      { actionId: `replace-list-position-${index}` },
      document.root.sharedId,
      blockSelection([selected]),
      insertMarkdown,
      { contextId: selected.sharedId, markdown: 'Pasted\n\n* Nested' },
    );

    expect(accepted).toBeDefined();
    expect(document.root.children[0]).toBe(list);
    expect(list.children[0]).toBe(item);
    expect(item.checked).toBe(true);
    expect(item.children.map((node) => (node.type === 'list' ? 'list' : node.content))).toEqual([
      ...['Before', 'Selected', 'After'].slice(0, index),
      'Pasted',
      'list',
      ...['Before', 'Selected', 'After'].slice(index + 1),
    ]);
    expect(untouched.every((node) => document.node(node.sharedId) === node)).toBe(true);
    expect(document.root.children[0]!.children[1]).toBe(tailItem);
    expect(document.validate().valid).toBe(true);

    const after = document.exportMarkdownTree();
    expect(writer.undo().status).toBe('applied');
    expect(document.exportMarkdownTree()).toEqual(before);
    expect(writer.redo().status).toBe('applied');
    expect(document.exportMarkdownTree()).toEqual(after);
  },
);

it('removes selected list items and renumbers surviving ordered items without replacing them', () => {
  const { document, writer } = create('5. Old\n6. Removed\n7. Tail');
  const list = document.root.children[0]!;
  const [destination, removed, tail] = list.children;
  const tailText = tail!.children[0]!;

  const accepted = runCommand(
    writer,
    { actionId: 'replace-ordered-list-selection' },
    document.root.sharedId,
    blockSelection([findContent(document, 'Old'), findContent(document, 'Removed')], true),
    insertMarkdown,
    { contextId: findContent(document, 'Old').sharedId, markdown: 'Pasted' },
  );

  expect(accepted).toBeDefined();
  expect(list.children.map((item) => item.marker)).toEqual(['5. ', '6. ']);
  expect(list.children[0]).toBe(destination);
  expect(list.children[1]).toBe(tail);
  expect(list.children[1]!.children[0]).toBe(tailText);
  expect(removed!.connected).toBe(false);
  expect(document.validate().valid).toBe(true);
});

it('lifts unselected section children after the pasted replacement', () => {
  const { document, writer } = create('# Old\n\nBody\n\n# Next\n\nNext body');
  const old = findContent(document, 'Old');
  const body = findContent(document, 'Body');
  const next = findContent(document, 'Next');
  const nextSection = next;

  const accepted = runCommand(
    writer,
    { actionId: 'replace-section-heading' },
    document.root.sharedId,
    blockSelection([old]),
    insertMarkdown,
    { contextId: old.sharedId, markdown: 'Pasted' },
  );

  expect(accepted).toBeDefined();
  expect(document.root.children.map((node) => node.content)).toEqual(['Pasted', 'Body', 'Next']);
  expect(document.root.children[1]).toBe(body);
  expect(document.root.children[2]).toBe(nextSection);
  expect(document.validate().valid).toBe(true);
});

it('lets an earlier existing list wrapper consume a pasted list wrapper', () => {
  const { document, writer } = create('* Left\n\nOld');
  const list = document.root.children[0]!;
  const leftItem = list.children[0]!;
  const old = findContent(document, 'Old');

  const accepted = runCommand(
    writer,
    { actionId: 'replace-after-existing-list' },
    document.root.sharedId,
    blockSelection([old]),
    insertMarkdown,
    { contextId: old.sharedId, markdown: '* Pasted' },
  );

  expect(accepted).toBeDefined();
  expect(document.root.children).toEqual([list]);
  expect(list.children[0]).toBe(leftItem);
  expect(list.children.map((item) => item.children[0]!.content)).toEqual(['Left', 'Pasted']);
  expect(document.validate().valid).toBe(true);
});

it.each([
  {
    name: 'right-side list collision',
    source: 'Old\n\n* Tail',
    selected: ['Old'],
    markdown: '* Pasted',
  },
  {
    name: 'right-side quote collision',
    source: 'Old\n\n> Tail',
    selected: ['Old'],
    markdown: '> Pasted',
  },
  {
    name: 'section reparenting list collision',
    source: 'Lead\n\nOld\n\n* Tail',
    selected: ['Old'],
    markdown: '# Pasted\n\n* New',
  },
  {
    name: 'section reparenting quote collision',
    source: 'Lead\n\nOld\n\n> Tail',
    selected: ['Old'],
    markdown: '# Pasted\n\n> New',
  },
  {
    name: 'lifting a section exposes a list collision',
    source: 'Lead\n\n# Old\n\n* Tail',
    selected: ['Old'],
    markdown: '* Pasted',
  },
  {
    name: 'separator between existing lists',
    source: '* Left\n\nOld\n\n* Right',
    selected: ['Old'],
    markdown: '* Pasted',
  },
])('declines $name without changing the canonical draft', ({ source, selected, markdown }) => {
  const { document, writer } = create(source);
  const targets = selected.map((content) => findContent(document, content));
  const before = document.canonicalSnapshot();
  const apply = vi.spyOn(writer, 'apply');

  const result = runCommand(
    writer,
    { actionId: `decline-${source.length}-${markdown.length}` },
    document.root.sharedId,
    blockSelection(targets),
    insertMarkdown,
    { contextId: targets[0]!.sharedId, markdown },
  );

  expect(result).toBeUndefined();
  expect(apply).not.toHaveBeenCalled();
  expect(document.canonicalSnapshot()).toEqual(before);
  expect(writer.canUndo()).toBe(false);
  expect(document.validate().valid).toBe(true);
});

it('declines a same-level heading that would move selected content outside its host scope', () => {
  const { document, writer } = create('Lead\n\n# Host\n\nOld\n\nTail\n\n# Outside\n\nBody');
  const host = findContent(document, 'Host');
  const old = findContent(document, 'Old');
  const before = document.canonicalSnapshot();
  const apply = vi.spyOn(writer, 'apply');

  const result = runCommand(
    writer,
    { actionId: 'decline-heading-scope-escape' },
    host.sharedId,
    blockSelection([old]),
    insertMarkdown,
    { contextId: old.sharedId, markdown: '# Pasted' },
  );

  expect(result).toBeUndefined();
  expect(apply).not.toHaveBeenCalled();
  expect(document.canonicalSnapshot()).toEqual(before);
  expect(writer.canUndo()).toBe(false);
});

it('keeps a deeper pasted heading and unselected content inside its host scope', () => {
  const { document, writer } = create('Lead\n\n# Host\n\nOld\n\nTail\n\n# Outside\n\nBody');
  const host = findContent(document, 'Host');
  const old = findContent(document, 'Old');
  const tail = findContent(document, 'Tail');
  const outside = findContent(document, 'Outside');

  const accepted = runCommand(
    writer,
    { actionId: 'keep-heading-in-host-scope' },
    host.sharedId,
    blockSelection([old]),
    insertMarkdown,
    { contextId: old.sharedId, markdown: '## Pasted' },
  );

  expect(accepted).toBeDefined();
  expect(host.connected).toBe(true);
  const pasted = findContent(document, 'Pasted');
  expect(pasted.parent?.sharedId).toBe(host.sharedId);
  expect(tail.connected).toBe(true);
  expect(tail.parent?.sharedId).toBe(pasted.sharedId);
  expect(outside.parent?.sharedId).toBe(document.root.sharedId);
  expect(document.validate().valid).toBe(true);
});

it('declines a nested-list replacement that would detach the right unselected wrapper', () => {
  const document = CanonicalDocument.fromTree({
    type: 'document',
    children: [
      {
        type: 'list',
        children: [
          {
            type: 'list-item',
            marker: '* ',
            checked: true,
            children: [
              {
                type: 'list',
                children: [
                  {
                    type: 'list-item',
                    marker: '* ',
                    children: [{ type: 'paragraph', content: 'Left' }],
                  },
                ],
              },
              { type: 'paragraph', content: 'Old' },
              {
                type: 'list',
                children: [
                  {
                    type: 'list-item',
                    marker: '* ',
                    children: [{ type: 'paragraph', content: 'Tail' }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  const writer = new CanonicalWriter(document);
  open.push({ document, writer });
  const old = findContent(document, 'Old');
  const before = document.canonicalSnapshot();
  const apply = vi.spyOn(writer, 'apply');

  const result = runCommand(
    writer,
    { actionId: 'decline-nested-list-collision' },
    document.root.sharedId,
    blockSelection([old]),
    insertMarkdown,
    { contextId: old.sharedId, markdown: '* Pasted' },
  );

  expect(result).toBeUndefined();
  expect(apply).not.toHaveBeenCalled();
  expect(document.canonicalSnapshot()).toEqual(before);
  expect(writer.canUndo()).toBe(false);
});

it.each([
  ['separate lists', '* First\n\nSeparator\n\n* Second', ['First', 'Second']],
  ['mixed list and section', '* First\n\n# Heading\n\nBody', ['First', 'Heading']],
  ['section and descendant', '# Heading\n\nBody', ['Heading', 'Body']],
])('declines %s selections that have no supported destination', (_name, source, selected) => {
  const { document, writer } = create(source);
  const targets = selected.map((content) => findContent(document, content));
  const before = document.canonicalSnapshot();
  const apply = vi.spyOn(writer, 'apply');

  expect(
    runCommand(
      writer,
      { actionId: `decline-mixed-${source.length}` },
      document.root.sharedId,
      blockSelection(targets),
      insertMarkdown,
      { contextId: targets[0]!.sharedId, markdown: 'Pasted' },
    ),
  ).toBeUndefined();
  expect(apply).not.toHaveBeenCalled();
  expect(document.canonicalSnapshot()).toEqual(before);
  expect(writer.canUndo()).toBe(false);
});
