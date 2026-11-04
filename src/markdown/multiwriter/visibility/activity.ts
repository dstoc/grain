import { compareActions } from '../contracts.js';
import type { ActionEnvelope, ActionId, SemanticEffect } from '../contracts.js';
import { actionKey, groupKey } from './identity.js';

export interface EffectRef {
  readonly action: ActionId;
  readonly ordinal: number;
}

export interface ActiveEffect extends EffectRef {
  readonly effect: Exclude<SemanticEffect, { type: 'SetGroupActive' }>;
}

/** A full reference reduction, not an ingest store or a local history cursor. */
export interface Activity {
  /** Includes inactive actions and controls; allocations are never retracted. */
  readonly actions: readonly ActionEnvelope[];
  /** Original semantic order and ordinals, including after reactivation. */
  readonly effects: readonly ActiveEffect[];
  isActive(action: ActionId): boolean;
  isEffectActive(effect: EffectRef): boolean;
  observes(observer: ActionId, prior: ActionId): boolean;
  concurrent(left: ActionId, right: ActionId): boolean;
}

/**
 * Input is the immutable, unique, dependency-closed ready set from MW-01.
 * This boundary checks the history rules; codec/native/reference validation
 * remains with ingest. Incomplete input throws instead of applying half a control.
 */
export function reduceActivity(input: readonly ActionEnvelope[]): Activity {
  const actions = [...input].sort(compareActions);
  const byId = new Map<string, ActionEnvelope>();
  const past = new Map<string, ReadonlySet<string>>();
  const controls = new Map<string, ActionEnvelope>();
  const groups = new Map<string, ActionEnvelope[]>();
  const active = new Map<string, boolean>();

  function requireAction(id: ActionId): ActionEnvelope {
    const action = byId.get(actionKey(id));
    if (!action) throw new Error(`Action is outside the ready closure: ${actionKey(id)}`);
    return action;
  }

  for (const action of actions) {
    const key = actionKey(action.id);
    if (byId.has(key)) throw new Error(`Duplicate action in ready set: ${key}`);
    byId.set(key, action);
    const closure = new Set<string>();
    for (const dependency of action.dependencies) {
      const dependencyKey = actionKey(dependency);
      const ancestors = past.get(dependencyKey);
      if (!ancestors) throw new Error(`Missing or unordered dependency: ${dependencyKey}`);
      closure.add(dependencyKey);
      for (const ancestor of ancestors) closure.add(ancestor);
    }
    past.set(key, closure);
    active.set(key, true);
    if (action.groupId.session.actor !== action.id.actor)
      throw new Error('An action must belong to its actor session');
    const control = action.effects.find((effect) => effect.type === 'SetGroupActive');
    if (!control) {
      const group = groupKey(action.groupId);
      if (controls.has(group)) throw new Error('A controlled group is sealed');
      const members = groups.get(group) ?? [];
      members.push(action);
      groups.set(group, members);
      continue;
    }
    if (
      action.effects.length !== 1 ||
      action.allocations.length ||
      action.nativeManifest.length ||
      action.nativeInsertUpdates.length
    )
      throw new Error('A group control cannot contain editable effects or allocations');
    if (
      action.id.actor !== control.group.session.actor ||
      action.groupId.session.local !== control.group.session.local
    )
      throw new Error('Only the owning session can control a group');

    const group = groupKey(control.group);
    const previous = controls.get(group);
    if (
      (previous ? actionKey(previous.id) : null) !==
      (control.previousControl ? actionKey(control.previousControl) : null)
    )
      throw new Error('Control must extend the previous owner control');
    if (previous && !closure.has(actionKey(previous.id)))
      throw new Error('Control must observe the previous owner control');
    const members = groups.get(group) ?? [];
    const targets = new Set(control.actions.map(actionKey));
    if (
      !targets.size ||
      targets.size !== control.actions.length ||
      targets.size !== members.length ||
      members.some((member) => !targets.has(actionKey(member.id)))
    )
      throw new Error('Control must target every action in one nonempty sealed group');
    for (const id of control.actions) {
      requireAction(id);
      if (!closure.has(actionKey(id))) throw new Error('Control must observe all target actions');
      active.set(actionKey(id), control.active);
    }
    controls.set(group, action);
  }

  function isActive(id: ActionId): boolean {
    requireAction(id);
    return active.get(actionKey(id))!;
  }
  function observes(observer: ActionId, prior: ActionId): boolean {
    requireAction(observer);
    requireAction(prior);
    return past.get(actionKey(observer))!.has(actionKey(prior));
  }
  function isEffectActive(ref: EffectRef): boolean {
    const action = requireAction(ref.action);
    const effect = action.effects[ref.ordinal];
    if (!Number.isSafeInteger(ref.ordinal) || ref.ordinal < 0 || !effect)
      throw new Error('Unknown effect ordinal');
    return effect.type !== 'SetGroupActive' && isActive(ref.action);
  }

  return {
    actions,
    effects: actions.flatMap((action) =>
      isActive(action.id)
        ? action.effects.flatMap((effect, ordinal) =>
            effect.type === 'SetGroupActive' ? [] : [{ action: action.id, ordinal, effect }],
          )
        : [],
    ),
    isActive,
    isEffectActive,
    observes,
    concurrent(left, right) {
      requireAction(left);
      requireAction(right);
      return (
        actionKey(left) !== actionKey(right) && !observes(left, right) && !observes(right, left)
      );
    },
  };
}
