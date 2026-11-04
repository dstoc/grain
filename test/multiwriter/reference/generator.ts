import type { Intent, Observation, TraceAction } from '../trace.js';
import type { SeededRandom } from '../network.js';

/** Choices use only the selected peer's publication and live navigation. The
 * command log supplies symbolic counters/history targets, never remote state.
 */
export function generateAction(
  peer: string,
  state: Observation,
  commands: readonly TraceAction[],
  random: SeededRandom,
  preference?: 'create' | 'undo' | 'redo',
): TraceAction {
  const byId = new Map(commands.map((command) => [command.id, command]));
  const own = commands.filter((command) => command.peer === peer);
  const sequence =
    own.reduce((n, command) => (command.sequence > n ? command.sequence : n), 0n) + 1n;
  const id = `${peer}${sequence}`;
  const fresh = `n${id}`;
  const pick = <T>(values: readonly T[]): T => values[random.next(values.length)];
  const leaves = state.view.filter(
    (node) =>
      ['paragraph', 'section', 'code-block'].includes(node.kind) &&
      !state.view.some((child) => child.parent === node.id) &&
      !state.deletedNodes.includes(node.id),
  );
  const parents = [
    'root',
    ...state.view.filter((node) => node.kind === 'block-quote').map((node) => node.id),
  ];
  const options: (readonly Intent[])[] = [];
  // Creation guarantees useful progress even after every original block is deleted.
  options.push([
    {
      type: 'create',
      block: {
        id: fresh,
        parent: pick(parents),
        role: 'inline',
        flow: `f${fresh}`,
        run: `r${fresh}`,
        tape: `t${fresh}`,
        cells: [...'abc'].map((text, i) => ({ id: `${fresh}${i}`, text })),
      },
      predecessor: null,
    },
  ]);
  for (const node of leaves) {
    const flow = `f${node.id}`;
    if (!state.resources[flow]) continue; // grouped representatives need constituent addresses
    const destinations = parents.filter((parent) => parent !== state.rawParents[node.id]);
    const parent = destinations.length ? pick(destinations) : 'root';
    options.push([
      { type: 'move', node: node.id, parent, predecessor: null, standaloneFlow: flow },
    ]);
    options.push([
      { type: 'move', node: node.id, parent, predecessor: null, standaloneFlow: flow },
      { type: 'properties', node: node.id, values: { marker: '##' } },
    ]);
    options.push([
      {
        type: 'interpret',
        packet: `packet${id}`,
        source: node.id,
        presentation: pick(['paragraph', 'section', 'code'] as const),
        mask: [],
        wrappers: [],
      },
    ]);
    const cells = state.visible[node.id] ?? [];
    if (cells.length) options.push([{ type: 'delete-text', tag: `d${id}`, cells: [pick(cells)] }]);
    options.push([
      {
        type: 'delete-subtree',
        tag: `d${id}`,
        target: node.id,
        observedNodes: [node.id],
        coveredCells: cells,
        joinedFlows: [],
      },
    ]);
    // Fresh inline homes have a known tape/edge address independent of their
    // current parent and of transferred content. Original fixture homes use :end.
    if (node.id.startsWith('n'))
      options.push([
        {
          type: 'insert',
          cell: `text${id}`,
          text: pick(['x', '😀', 'é']),
          tape: `t${node.id}`,
          slot: `${node.id}:home-end`,
        },
      ]);
    // A complete, unchanged created component gives an exact author basis. More
    // general refined/empty-cell splits remain covered by the frozen corpus.
    const born = commands
      .flatMap((command) => command.intents)
      .find((intent) => intent.type === 'create' && intent.block.id === node.id);
    const original = born?.type === 'create' ? born.block.cells?.map((cell) => cell.id) : undefined;
    const pristine =
      original?.length &&
      JSON.stringify(state.skeletons[`r${node.id}`]) === JSON.stringify(original) &&
      JSON.stringify(cells) === JSON.stringify(original) &&
      original.every((cell) => state.cellRuns[cell] === `r${node.id}`) &&
      !Object.values(state.flowParents).includes(`flow:${flow}@${node.id}:end`) &&
      !commands.some(
        (command) =>
          state.ready.includes(command.id) &&
          command.intents.some((intent) => intent.type === 'split' && intent.source === node.id),
      );
    if (pristine)
      options.push([
        {
          type: 'split',
          source: node.id,
          basis: original,
          after: pick([null, ...original]),
          marker: `cut${id}`,
          retainedSide: pick(['left', 'right'] as const),
          node: fresh,
          flow: `f${fresh}`,
          run: `r${fresh}`,
          parent: state.rawParents[node.id]!,
          predecessor: null,
        },
      ]);
    for (const destination of leaves) {
      if (destination.id === node.id || !state.resources[`f${destination.id}`]) continue;
      options.push([{ type: 'join', source: flow, destinationSlot: `${destination.id}:end` }]);
      if (pristine)
        options.push([
          {
            type: 'transfer',
            cells: [pick(original)],
            destinationSlot: `${destination.id}:end`,
            run: `rtransfer${id}`,
          },
        ]);
    }
  }
  for (const [groups, active] of [
    [state.undo, false],
    [state.redo, true],
  ] as const) {
    const group = groups.at(-1);
    if (!group) continue;
    const actions = commands.filter(
      (command) =>
        command.peer === peer &&
        command.group === group &&
        !command.intents.some((intent) => intent.type === 'control') &&
        state.ready.includes(command.id),
    );
    if (!actions.length) continue;
    const previous = [...commands]
      .reverse()
      .find(
        (command) =>
          state.ready.includes(command.id) &&
          command.intents.some((intent) => intent.type === 'control' && intent.group === group),
      );
    options.push([
      {
        type: 'control',
        group,
        actions: actions.map((action) => action.id),
        active,
        previous: previous?.id ?? null,
      },
    ]);
  }
  const dependencies = [...state.heads];
  const lamport =
    dependencies.reduce((n, name) => {
      const value = byId.get(name)!.lamport;
      return value > n ? value : n;
    }, 0n) + 1n;
  // Keep creating new subjects as the view changes instead of exhausting genesis.
  const types = [...new Set(options.map((intents) => intents[0].type))];
  const type = pick(types);
  const preferred =
    preference === 'create'
      ? options[0]
      : preference
        ? options.find(
            (intents) =>
              intents[0].type === 'control' && intents[0].active === (preference === 'redo'),
          )
        : undefined;
  if (preference && !preferred) throw new Error(`Unavailable generated ${preference}`);
  const intents = preferred ?? pick(options.filter((intents) => intents[0].type === type));
  return { id, peer, sequence, lamport, dependencies, group: id, intents };
}
