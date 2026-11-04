import type { ActionEnvelope, OccurrenceId, SemanticEffect } from '../contracts.js';
import type { BirthPlacement, LayoutGenesis } from '../layout/index.js';
import { resourceKey } from '../layout/index.js';
import { sameSlot } from '../layout/occurrences.js';
import { deriveHomes } from '../ownership/index.js';
import type { BirthContent } from '../projection/index.js';

/** An unresolved retained relationship stops composition; it is never guessed from ID order. */
export class ProvenanceError extends Error {}

function placementOccurrences(effect: SemanticEffect): readonly OccurrenceId[] {
  switch (effect.type) {
    case 'MoveBlock':
    case 'JoinFlow':
    case 'TransferRange':
      return [effect.occurrence];
    case 'LiftChildren':
      return effect.placements.map((placement) => placement.occurrence);
    case 'Interpret':
      return effect.packet.placements.map((placement) => placement.occurrence);
    default:
      return [];
  }
}

/** Recover bindings from one immutable batch. Split constructors bind explicitly;
 * ordinary births require a unique unused occurrence at their exact birth slot.
 * Multiple births at one parent can use distinct predecessor-chain slots.
 */
export function reconstructBirths(action: ActionEnvelope): readonly BirthPlacement[] {
  const occurrences = action.allocations.filter((entry) => entry.type === 'occurrence');
  const later = new Set(action.effects.flatMap(placementOccurrences).map(resourceKey));
  const used = new Set<string>();
  return action.allocations.flatMap((node): BirthPlacement[] => {
    if (node.type !== 'node' || node.role === 'root') return [];
    if (!node.birthSlot) throw new ProvenanceError('Non-root birth needs a block slot');
    const constructors = action.effects.filter(
      (effect) =>
        effect.type === 'SplitFlow' && resourceKey(effect.newNode) === resourceKey(node.id),
    );
    if (constructors.length > 1)
      throw new ProvenanceError('Multiple split constructors for one birth');
    const split = constructors[0];
    const candidates = occurrences.filter((entry) =>
      split?.type === 'SplitFlow'
        ? resourceKey(entry.id) === resourceKey(split.occurrence)
        : !later.has(resourceKey(entry.id)) && sameSlot(entry.slot, node.birthSlot!),
    );
    if (candidates.length !== 1)
      throw new ProvenanceError('Birth occurrence is missing or ambiguous');
    const occurrence = candidates[0];
    const key = resourceKey(occurrence.id);
    if (!sameSlot(occurrence.slot, node.birthSlot) || used.has(key))
      throw new ProvenanceError('Birth occurrence must match exactly one node');
    if (split?.type === 'SplitFlow' && !sameSlot(split.outerSlot, node.birthSlot))
      throw new ProvenanceError('Split constructor differs from birth slot');
    used.add(key);
    return [{ node: node.id, occurrence: occurrence.id }];
  });
}

/** Pure assembly over a CERTIFIED ready set. The store must certify every action
 * with createProjectionAuthorValidator(reconstructBirths) on its exact native
 * dependency closure. In particular, a split's retained root skeleton must equal
 * its pre-effect authored component. Merged ownership is never birth coverage.
 *
 * grain/89 proposal v2: private home plus explicit split constructor; transfers,
 * joins, later controls and packet eligibility cannot change retained coverage.
 */
export function reconstructProvenance(genesis: LayoutGenesis, actions: readonly ActionEnvelope[]) {
  const inputs = actions.map((action) => ({ action, births: reconstructBirths(action) }));
  const birthContent: BirthContent[] = [
    { ...genesis, effects: [] as readonly SemanticEffect[] },
    ...inputs.map(({ action, births }) => ({ ...action, births })),
  ].flatMap((batch) => {
    const homes = deriveHomes(batch, batch.effects);
    const runs = new Map(
      batch.allocations.filter((a) => a.type === 'run').map((a) => [resourceKey(a.id), a]),
    );
    const homeByFlow = new Map(
      homes.map((home) => {
        const run = runs.get(resourceKey(home.run));
        if (!run) throw new ProvenanceError('Private home has no root');
        return [resourceKey(run.flow), { home, root: run }] as const;
      }),
    );
    return batch.allocations.flatMap((node): BirthContent[] => {
      if (node.type !== 'node') return [];
      if (!node.flow) return [{ node: node.id, intervals: [] }];
      const binding = homeByFlow.get(resourceKey(node.flow));
      if (!binding) throw new ProvenanceError('Inline birth has no private home');
      const { home, root } = binding;
      const split = batch.effects.find(
        (effect) =>
          effect.type === 'SplitFlow' && resourceKey(effect.newNode) === resourceKey(node.id),
      );
      if (
        split?.type === 'SplitFlow' &&
        (resourceKey(split.newRun) !== resourceKey(root.id) ||
          resourceKey(split.newFlow) !== resourceKey(node.flow))
      )
        throw new ProvenanceError('Split constructor differs from private home root');
      return [{ node: node.id, intervals: structuredClone(split ? root.skeleton : [home.cell]) }];
    });
  });
  return { actions: inputs, birthContent };
}
