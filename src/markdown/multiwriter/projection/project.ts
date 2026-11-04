import { serializeToString } from '../../block-serializer.js';
import type { DocumentNode, MarkdownNode } from '../../node.js';
import { isAllowedSemanticChild } from '../../semantic/types.js';
import type {
  ActionEnvelope,
  Allocation,
  DeletionId,
  NativeResourceBirth,
  NativeTextRange,
  NodeId,
} from '../contracts.js';
import type { BirthPlacement, LayoutGenesis } from '../layout/index.js';
import { resourceKey } from '../layout/index.js';
import { reduceOwnership } from '../ownership/index.js';
import type { NativeView } from '../ingest/publication.js';
import { NativeValidationError } from '../text/identity.js';
import { reduceActivity, reduceVisibility } from '../visibility/index.js';
import type { TextToken, VisibilityLayout } from '../visibility/index.js';
import {
  ProjectionError,
  selectInterpretations,
  validatePacket,
  validateMembership,
} from './interpretation.js';
import type { PresentedProperties } from './interpretation.js';
import { normalizeProjection } from './normalize.js';
import type { BirthContent, MutableViewNode, ProjectionView, ViewNode } from './types.js';
import { textOrigin } from './types.js';

export interface ProjectionInput {
  readonly genesis: LayoutGenesis;
  readonly genesisManifest: readonly NativeResourceBirth[];
  readonly actions: readonly {
    readonly action: ActionEnvelope;
    readonly births: readonly BirthPlacement[];
  }[];
  /** Read-only native cache of exactly this ready set. */
  readonly native: NativeView;
  readonly initialProperties?: readonly {
    readonly node: NodeId;
    readonly values: Partial<PresentedProperties>;
  }[];
  /** Supplied by MW-05/MW-08 from exact birth closures; final ownership is insufficient. */
  readonly birthContent: readonly BirthContent[];
}
const tokenKey = (token: TextToken) =>
  `${resourceKey(token.tape)}:${token.native.client}:${token.native.clock}`;
const rangeToken = (range: NativeTextRange, i: number) => ({
  tape: range.tape,
  native: { client: range.client, clock: range.clock + i },
});

/** Full reference projection of one ready snapshot; no shared mutation API is accepted. */
export function projectMarkdown(input: ProjectionInput) {
  try {
    return project(input);
  } catch (error) {
    if (error instanceof NativeValidationError) throw new ProjectionError(error.message);
    throw error;
  }
}
function project(input: ProjectionInput) {
  const groupActivity = reduceActivity(input.actions.map(({ action }) => action));
  const interpretations = selectInterpretations(groupActivity, input.initialProperties);
  const effectActive = (ref: Parameters<typeof groupActivity.isEffectActive>[0]) =>
    groupActivity.isEffectActive(ref) && interpretations.effectEligible(ref);
  const activity = {
    ...groupActivity,
    effects: groupActivity.effects.filter(effectActive),
    isEffectActive: effectActive,
  };
  const allocations = [
    ...input.genesis.allocations,
    ...activity.actions.flatMap((action) => action.allocations),
  ];
  const initial = input.initialProperties ?? [];
  if (
    new Set(initial.map((entry) => resourceKey(entry.node))).size !== initial.length ||
    initial.some(
      (entry) =>
        !allocations.some(
          (allocation) =>
            allocation.type === 'node' && resourceKey(allocation.id) === resourceKey(entry.node),
        ),
    )
  )
    throw new ProjectionError('Initial properties require unique retained node origins');
  const read = (range: NativeTextRange) =>
    input.native
      .lookup(range)
      .map((fragment) => fragment.text)
      .join('');
  for (const action of activity.actions) {
    validateMembership(action, allocations);
    for (const effect of action.effects)
      if (effect.type === 'Interpret') validatePacket(effect.packet, allocations, read);
  }
  const snapshots = allocations
    .filter((allocation) => allocation.type === 'tape')
    .map((tape) => input.native.snapshot(tape.id));
  const ownership = reduceOwnership({
    genesis: input.genesis,
    actions: input.actions,
    snapshots,
    isActive: (order) =>
      activity.isEffectActive({ action: order.action.id, ordinal: order.ordinal }),
    interpretationEligible: (order) =>
      interpretations.eligible({ action: order.action.id, ordinal: order.ordinal }),
  });
  const birthContent = new Map(
    input.birthContent.map((entry) => [resourceKey(entry.node), entry.intervals]),
  );
  if (
    birthContent.size !== input.birthContent.length ||
    birthContent.size !== ownership.nodeAllocations.length ||
    ownership.nodeAllocations.some((node) => !birthContent.has(resourceKey(node.id)))
  )
    throw new ProjectionError('Birth-causal coverage must include every retained node');
  for (const entry of input.birthContent)
    for (const interval of entry.intervals) ownership.cells(interval);
  const manifests = [
    ...input.genesisManifest.map((entry) => ({ entry, birth: null })),
    ...activity.actions.flatMap((action) =>
      action.nativeManifest.map((entry) => ({ entry, birth: action.id })),
    ),
  ];
  const births = new Map<string, TextToken['birth']>();
  for (const { entry, birth } of manifests) {
    if (entry.type !== 'text') continue;
    const range = { tape: entry.tape, ...entry.native };
    if (read(range) !== entry.text)
      throw new ProjectionError('Native snapshot text differs from its insertion manifest');
    for (let i = 0; i < entry.native.length; i++) {
      const key = tokenKey({ ...rangeToken(range, i), birth });
      if (births.has(key)) throw new ProjectionError('Duplicate native text birth');
      births.set(key, birth);
    }
  }
  const markers = new Map(
    allocations
      .filter((entry) => entry.type === 'marker')
      .map((entry) => [resourceKey(entry.id), entry]),
  );
  const seenMarkers = new Set<string>();
  const tokens: TextToken[] = snapshots.flatMap((snapshot) =>
    snapshot.parts.flatMap((part) => {
      if (part.type === 'marker') {
        seenMarkers.add(resourceKey(part.marker));
        const marker = markers.get(resourceKey(part.marker));
        if (
          !marker ||
          resourceKey(marker.tape) !== resourceKey(snapshot.tape) ||
          marker.native.client !== part.native.client ||
          marker.native.clock !== part.native.clock
        )
          throw new ProjectionError('Native snapshot contains an unknown marker');
        return [];
      }
      return Array.from({ length: part.text.length }, (_, i) => {
        const token = {
          tape: snapshot.tape,
          native: { client: part.native.client, clock: part.native.clock + i },
          birth: null,
        };
        const key = tokenKey(token);
        if (!births.has(key))
          throw new ProjectionError('Native snapshot contains text outside the ready set');
        return { ...token, birth: births.get(key)! };
      });
    }),
  );
  if (seenMarkers.size !== markers.size)
    throw new ProjectionError('Native snapshot is missing retained markers');
  if (tokens.length !== births.size)
    throw new ProjectionError('Native snapshot is missing insertion-manifest text');
  const flowByRun = new Map(ownership.runLayouts.map((run) => [resourceKey(run.run), run.flow]));
  const visibilityLayout: VisibilityLayout = {
    nodes: ownership.nodeAllocations,
    parent: (node) => ownership.blockPlacement(node)?.slot.parent ?? null,
    owner: (token) => ownership.flowBlock(flowByRun.get(resourceKey(ownership.owner(token).run))!),
    requirements: (node) =>
      ownership.destinationRequirements
        .filter((requirement) =>
          requirement.nodes.some((id) => resourceKey(id) === resourceKey(node)),
        )
        .map(({ order }) => ({ action: order.action.id, ordinal: order.ordinal })),
    contains: (range, token) => ownership.contains(range, token),
    containsBirthContent: (node, token) =>
      birthContent.get(resourceKey(node))!.some((range) => ownership.contains(range, token)),
  };
  const initialVisibility = reduceVisibility(
    activity,
    visibilityLayout,
    tokens,
    interpretations.birthEnabled,
  );
  // A concurrent deletion can leave a split with no surviving derivation. Its
  // header is weakly suppressed, not tombstoned by historical source identity.
  // Visible peer content, children and independent placements still keep it.
  // A split observed by the deletion is already separated and is not a candidate.
  const hiddenDerivations = new Map<string, { action: ActionEnvelope['id']; ordinal: number }>();
  const nodeVisibility = new Map(
    initialVisibility.nodes.map((entry) => [resourceKey(entry.node), entry]),
  );
  const sourceDeletedBy = (node: NodeId, tag: DeletionId) => {
    let current: NodeId | null = node;
    while (current) {
      if (
        nodeVisibility
          .get(resourceKey(current))!
          .tags.some((value) => resourceKey(value) === resourceKey(tag))
      )
        return true;
      current = visibilityLayout.parent(current);
    }
    return false;
  };
  for (const entry of activity.effects) {
    if (entry.effect.type !== 'SplitFlow') continue;
    const split = entry.effect;
    const run = ownership.runLayouts.find(
      (run) => resourceKey(run.run) === resourceKey(split.cut.run),
    )!;
    const source = ownership.nodeAllocations.find(
      (node) => node.flow && resourceKey(node.flow) === resourceKey(run.flow),
    )!;
    if (
      activity.effects.some(
        (deletion) =>
          deletion.effect.type === 'DeleteSubtree' &&
          activity.concurrent(entry.action, deletion.action) &&
          sourceDeletedBy(source.id, deletion.effect.tag),
      )
    )
      hiddenDerivations.set(resourceKey(entry.effect.newNode), {
        action: entry.action,
        ordinal: entry.ordinal,
      });
  }
  const hiddenEffects = new Set(
    [...hiddenDerivations.values()].map(
      (ref) => `${ref.action.actor}:${ref.action.sequence}:${ref.ordinal}`,
    ),
  );
  const visibility = hiddenDerivations.size
    ? reduceVisibility(
        activity,
        {
          ...visibilityLayout,
          requirements: (node) =>
            visibilityLayout
              .requirements(node)
              .filter(
                (ref) =>
                  !hiddenEffects.has(`${ref.action.actor}:${ref.action.sequence}:${ref.ordinal}`),
              ),
        },
        tokens,
        (node) => interpretations.birthEnabled(node) && !hiddenDerivations.has(resourceKey(node)),
      )
    : initialVisibility;
  const visibleTokens = new Map(
    visibility.text.map((entry) => [tokenKey(entry.token), entry.visible]),
  );
  const available = new Set(
    visibility.nodes.filter((entry) => entry.available).map((entry) => resourceKey(entry.node)),
  );
  const nodes = new Map(ownership.nodeAllocations.map((node) => [resourceKey(node.id), node]));
  const rootAllocation = ownership.nodeAllocations.find((node) => node.role === 'root');
  if (!rootAllocation) throw new ProjectionError('Missing document root');
  function build(id: NodeId): MutableViewNode[] {
    const allocation = nodes.get(resourceKey(id));
    if (!allocation) throw new ProjectionError('Unknown raw child');
    if (!available.has(resourceKey(id))) return [];
    const properties = interpretations.properties(id);
    const type = nodeType(allocation, properties);
    const placement = ownership.blockPlacement(id);
    const edge = placement ? { type: 'edge' as const, child: id, slot: placement.slot } : null;
    const result: MutableViewNode = {
      origin: { type: 'node', representative: id, constituents: [id] },
      edge,
      type,
      marker:
        properties.marker ??
        (type === 'section'
          ? '#'
          : type === 'list-item'
            ? '- '
            : type === 'block-quote'
              ? '> '
              : null),
      info: properties.info,
      checked: properties.checked,
      content: '',
      children: [],
      fragments: [],
      boundaries: [],
      wrappers: [],
    };
    const children = ownership.children(id).flatMap(build);
    const absorbed =
      allocation.flow !== null &&
      ownership.flowPlacements.some(
        (flow) =>
          resourceKey(flow.flow) === resourceKey(allocation.flow!) && flow.parent.type === 'flow',
      );
    if (allocation.flow && !absorbed) {
      for (const entry of ownership.raw(allocation.flow)) {
        if (entry.type === 'slot') {
          const marker = input.native.marker(entry.slot.boundary);
          const tape = snapshots.find(
            (snapshot) => resourceKey(snapshot.tape) === resourceKey(marker.tape),
          )!;
          if (
            (marker.index === 0 && entry.slot.side === 'left') ||
            (marker.index === tape.length - 1 && entry.slot.side === 'right')
          )
            continue;
          const run = ownership.runLayouts.find(
            (run) => resourceKey(run.run) === resourceKey(entry.slot.run),
          )!;
          const origin = run.skeleton.find((range) =>
            ownership.containsBoundary(range, entry.slot.boundary),
          );
          if (!origin) throw new ProjectionError('Text slot lacks a retained origin');
          result.boundaries.push({
            offset: result.content.length,
            address: textOrigin(entry.slot, origin),
          });
        } else if (entry.type === 'cell') {
          const origin = entry.assignment.cell;
          for (const fragment of entry.fragments) {
            // Scalar visibility is computed without slicing a surrogate pair. Group only
            // adjacent units with identical predicates, then validate the resulting slices.
            let start = 0;
            while (start < fragment.text.length) {
              const state = (i: number) => ({
                visible:
                  visibleTokens.get(tokenKey({ ...rangeToken(fragment.range, i), birth: null })) ===
                  true,
                masked: interpretations.masked({
                  ...fragment.range,
                  clock: fragment.range.clock + i,
                  length: 1,
                }),
              });
              const current = state(start);
              let end = start + 1;
              while (
                end < fragment.text.length &&
                state(end).visible === current.visible &&
                state(end).masked === current.masked
              )
                end++;
              const range = {
                ...fragment.range,
                clock: fragment.range.clock + start,
                length: end - start,
              };
              const text = read(range); // Also rejects half-surrogate masks/deletions.
              const address = textOrigin(
                {
                  run: entry.assignment.run,
                  boundary: origin.start,
                  side: 'right',
                  predecessor: null,
                },
                origin,
              );
              const visible = current.visible && !current.masked;
              result.fragments.push({ text, range, address, visible, masked: current.masked });
              if (visible) result.content += text;
              start = end;
            }
          }
        }
      }
    }
    if (absorbed) return children;
    if (type === 'paragraph' || type === 'code-block') return [result, ...children];
    if (children.some((child) => !isAllowedSemanticChild(type, child.type)))
      throw new ProjectionError('Illegal projected child');
    result.children = children;
    if ((type === 'list' || type === 'block-quote' || type === 'list-item') && edge) {
      const rawChildren = ownership.children(id);
      const last = rawChildren.at(-1);
      result.wrappers.push({
        node: id,
        edge,
        start: { parent: id, predecessor: null },
        end: { parent: id, predecessor: last ? ownership.blockPlacement(last)!.occurrence : null },
      });
    }
    return [result];
  }
  const root = build(rootAllocation.id)[0];
  if (!root) throw new ProjectionError('Root must remain available');
  const normalized = normalizeProjection(root);
  const hasInline = (node: ViewNode): boolean =>
    ['paragraph', 'section', 'code-block'].includes(node.type) || node.children.some(hasInline);
  const view: ProjectionView = {
    root: normalized,
    emptyRoot: hasInline(normalized)
      ? null
      : { type: 'empty-root', slot: { parent: rootAllocation.id, predecessor: null } },
  };
  deepFreeze(view);
  return { view, ownership, activity, interpretations, visibility };
}
function nodeType(
  allocation: Extract<Allocation, { type: 'node' }>,
  properties: PresentedProperties,
): MarkdownNode['type'] {
  switch (allocation.role) {
    case 'root':
      return 'document';
    case 'quote':
      return 'block-quote';
    case 'list':
      return 'list';
    case 'list-item':
      return 'list-item';
    case 'inline':
      return properties.presentation === 'code' ? 'code-block' : properties.presentation;
  }
}
function deepFreeze(value: object): void {
  Object.freeze(value);
  for (const entry of Object.values(value))
    if (entry && typeof entry === 'object' && !Object.isFrozen(entry)) deepFreeze(entry);
}
/** Export delimiters/numbering are presentation only; content already has native origins. */
export function projectionDocument(view: ProjectionView): DocumentNode {
  function convert(node: ViewNode): MarkdownNode {
    const children = node.children.map(convert);
    switch (node.type) {
      case 'document':
        return { type: 'document', children };
      case 'paragraph':
        return { type: 'paragraph', content: node.content };
      case 'section':
        return { type: 'section', marker: node.marker ?? '#', content: node.content, children };
      case 'code-block':
        return { type: 'code-block', info: node.info, content: node.content };
      case 'list':
        return { type: 'list', children };
      case 'list-item':
        return {
          type: 'list-item',
          marker: node.marker ?? '- ',
          ...(node.checked === null ? {} : { checked: node.checked }),
          children,
        };
      case 'block-quote':
        return { type: 'block-quote', marker: node.marker ?? '> ', children };
    }
  }
  return convert(view.root) as DocumentNode;
}

/** The serializer's document input requires a child; empty-root views export no content. */
export function serializeProjection(view: ProjectionView): string {
  return view.root.children.length ? serializeToString(projectionDocument(view)) : '';
}
