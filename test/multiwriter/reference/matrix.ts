import type { ContractTrace, Intent, SeedBlock, Step, TraceAction } from '../trace.js';
const ids = [...'abcdef'].map((_, i) => `P${i}`);
const paragraph = (id: string, text: string): SeedBlock => ({
  id,
  parent: 'root',
  role: 'inline',
  flow: `f${id}`,
  run: `r${id}`,
  tape: `t${id}`,
  cells: [...text].map((text, i) => ({ id: `${id}${i}`, text })),
});
export const matrixSeed: readonly SeedBlock[] = [
  { id: 'root', parent: null, role: 'root' },
  paragraph('P', 'abcdef'),
  paragraph('Q', 'XY'),
  { id: 'U', parent: 'root', role: 'quote' },
  { id: 'V', parent: 'root', role: 'quote' },
];
export const structuralChoices = [
  'cut-b',
  'cut-d',
  'cut-zero',
  'cut-end',
  'join-q-p',
  'join-p-q',
  'move-u',
  'move-v',
  'transfer',
  'delete',
  'delete-text',
  'heading',
  'round-transfer',
  'move-twice',
  'join-transfer',
] as const;
export type StructuralChoice = (typeof structuralChoices)[number];
export function intents(choice: StructuralChoice, peer: string): readonly Intent[] {
  const node = `${peer}split`;
  const split = (after: string | null, retainedSide: 'left' | 'right' = 'left'): Intent => ({
    type: 'split',
    source: 'P',
    basis: ids,
    after,
    marker: `cut:${node}`,
    retainedSide,
    node,
    flow: `f${node}`,
    run: `r${node}`,
    parent: 'root',
    predecessor: retainedSide === 'left' ? 'P:birth' : null,
  });
  const move = (parent: string): Intent => ({
    type: 'move',
    node: 'P',
    parent,
    predecessor: null,
    standaloneFlow: 'fP',
  });
  switch (choice) {
    case 'cut-b':
      return [split('P1')];
    case 'cut-d':
      return [split('P3')];
    case 'cut-zero':
      return [split(null, 'right')];
    case 'cut-end':
      return [split('P5')];
    case 'join-q-p':
      return [{ type: 'join', source: 'fQ', destinationSlot: 'P:end' }];
    case 'join-p-q':
      return [{ type: 'join', source: 'fP', destinationSlot: 'Q:end' }];
    case 'move-u':
      return [move('U')];
    case 'move-v':
      return [move('V')];
    case 'transfer':
      return [
        {
          type: 'transfer',
          cells: ['P2', 'P3'],
          destinationSlot: 'Q:end',
          run: `r${peer}transfer`,
        },
      ];
    case 'delete':
      return [
        {
          type: 'delete-subtree',
          tag: `d${peer}`,
          target: 'P',
          observedNodes: ['P'],
          coveredCells: ids,
          joinedFlows: [],
        },
      ];
    case 'delete-text':
      return [{ type: 'delete-text', tag: `d${peer}`, cells: ['P1', 'P2'] }];
    case 'heading':
      return [
        {
          type: 'interpret',
          packet: `${peer}heading`,
          source: 'P',
          presentation: 'section',
          mask: [],
          wrappers: [],
        },
      ];
    case 'round-transfer':
      return [
        { type: 'transfer', cells: ['P2', 'P3'], destinationSlot: 'Q:end', run: `r${peer}out` },
        { type: 'transfer', cells: ['P2', 'P3'], destinationSlot: 'P:end', run: `r${peer}back` },
      ];
    case 'move-twice':
      return [move('U'), move('V')];
    case 'join-transfer':
      return [
        { type: 'join', source: 'fQ', destinationSlot: 'P:end' },
        {
          type: 'transfer',
          cells: ['P2', 'P3'],
          destinationSlot: 'Q:end',
          run: `r${peer}transfer`,
        },
      ];
  }
}
export function scenario(
  choices: readonly StructuralChoice[],
  id: string,
  controls = false,
): ContractTrace {
  const peers = ['A', 'B', 'C'] as const;
  const actions = choices.map((choice, i): TraceAction => ({
    id: `${peers[i]}1`,
    peer: peers[i],
    sequence: 1n,
    lamport: 1n,
    dependencies: [],
    group: `${peers[i]}1`,
    intents: intents(choice, peers[i]),
  }));
  const steps: Step[] = actions.map((action) => ({ type: 'author', action }));
  if (controls)
    for (const original of actions) {
      const control: TraceAction = {
        id: `${original.peer}2`,
        peer: original.peer,
        sequence: 2n,
        lamport: 2n,
        dependencies: [original.id],
        group: `${original.peer}2`,
        intents: [
          {
            type: 'control',
            group: original.group,
            actions: [original.id],
            active: false,
            previous: null,
          },
        ],
      };
      steps.push({ type: 'author', action: control });
      steps.push({
        type: 'author',
        action: {
          ...control,
          id: `${original.peer}3`,
          sequence: 3n,
          lamport: 3n,
          dependencies: [control.id],
          group: `${original.peer}3`,
          intents: [
            {
              type: 'control',
              group: original.group,
              actions: [original.id],
              active: true,
              previous: control.id,
            },
          ],
        },
      });
    }
  return {
    version: 3,
    id,
    sections: ['13'],
    purpose: 'Independent structural conflict enumeration and schedule generation.',
    genesis: 'G',
    peers,
    seed: matrixSeed,
    steps,
  };
}
