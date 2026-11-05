import type { ActionEnvelope, ActionId } from '../contracts.js';
import { isPropertyUpdate } from '../projection/interpretation.js';

/** These properties do not affect placement, normalization, text or addresses.
 * Presentation and marker changes retain the structural projection path.
 */
export function isPropertyRefinement(action: ActionEnvelope): boolean {
  return (
    isPropertyUpdate(action) &&
    action.effects.every(
      (effect) =>
        effect.type === 'SetProperties' &&
        Object.keys(effect.values).every((field) => field === 'checked' || field === 'info'),
    )
  );
}
export function propertyControlTargets(
  action: ActionEnvelope,
  lookup: (id: ActionId) => ActionEnvelope | undefined,
): readonly ActionEnvelope[] | undefined {
  const effect = action.effects[0];
  if (
    action.effects.length !== 1 ||
    effect?.type !== 'SetGroupActive' ||
    action.allocations.length ||
    action.nativeManifest.length ||
    action.nativeInsertUpdates.length ||
    !effect.actions.length
  )
    return undefined;
  const targets: ActionEnvelope[] = [];
  for (const id of effect.actions) {
    const target = lookup(id);
    if (!target || !isPropertyRefinement(target)) return undefined;
    targets.push(target);
  }
  return targets;
}
