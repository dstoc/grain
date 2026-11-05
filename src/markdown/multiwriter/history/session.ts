import type { ActionEnvelope, ActionId, GroupId, ProjectionAddress } from '../contracts.js';
import { assertCounter, DEFAULT_HISTORY_LIMIT } from '../contracts.js';
import type { InsertTextInput } from '../../../editing/commands/insert-text.js';
import type { Edit } from '../../../editing/outcomes.js';
import { insertText } from '../../../editing/commands/insert-text.js';
import { RetainedEditError } from '../authoring/errors.js';
import type { LocalEditOptions, LocalEditResult } from '../authoring/editor.js';
import { classifyFootprints, validScope } from './scope.js';
import type { Footprint } from './scope.js';
import { collapsedAt, resolveSelection } from './selection.js';
import type { HistoryPublication, SelectionRestoration, StableSelection } from './selection.js';

export interface HistoryOptions {
  readonly limit?: number;
  readonly clock?: () => number;
}
export interface ManagedEditOptions extends LocalEditOptions {
  /** Only literal insertText with a contiguous collapsed selection can coalesce. */
  readonly typing?: boolean;
}
export interface RetainedEdit {
  readonly envelope: ActionEnvelope;
  readonly footprint: Footprint;
  readonly emptyBefore: boolean;
  readonly emptyAfter: boolean;
  readonly selectionBefore?: StableSelection;
  readonly selectionAfter?: StableSelection;
}
export interface HistoryDriver {
  publication(): HistoryPublication;
  version(): number;
  capture(options: LocalEditOptions): StableSelection | undefined;
  edit<Input>(
    group: bigint,
    command: Edit<Input>,
    input: Input,
    options: LocalEditOptions,
    register: (edit: RetainedEdit) => void,
  ): LocalEditResult;
  empty(group: bigint, text: string, register: (edit: RetainedEdit) => void): LocalEditResult;
  control(
    group: bigint,
    effect: Extract<ActionEnvelope['effects'][number], { type: 'SetGroupActive' }>,
    register: (id: ActionId) => void,
  ): { action: ActionId; publication: HistoryPublication };
}
interface Group {
  id: GroupId;
  order: bigint;
  actions: ActionId[];
  footprints: Footprint[];
  before?: StableSelection;
  after?: StableSelection;
  emptyBefore: boolean;
  emptyAfter: boolean;
  previousControl: ActionId | null;
}
export interface NavigationOptions {
  readonly scope?: ProjectionAddress;
  /** Initiating host, separately from the optional history filter scope. */
  readonly host?: ProjectionAddress;
}
export type NavigationResult =
  | { readonly state: 'empty' | 'invalid-scope' }
  | {
      readonly state: 'blocked';
      readonly reason: 'mixed-footprint' | 'unresolved-footprint';
      readonly group: GroupId;
    }
  | {
      readonly state: 'applied';
      readonly group: GroupId;
      readonly action: ActionId;
      readonly restoration: SelectionRestoration;
      readonly version: number;
      readonly session: string;
    };

function limitValue(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 0)
    throw new Error('History limit must be a nonnegative safe integer');
  return limit;
}
/** Navigation metadata is local. Only immutable group controls enter canonical storage. */
export class HistorySession {
  private undoGroups: Group[] = [];
  private redoGroups: Group[] = [];
  private counter = 0n;
  private limit: number;
  private readonly clock: () => number;
  private open?: { group: Group; at: number };
  private busy = false;
  private resetNavigation = true;
  constructor(
    readonly local: string,
    private readonly driver: HistoryDriver,
    options: HistoryOptions = {},
  ) {
    this.limit = limitValue(options.limit ?? DEFAULT_HISTORY_LIMIT);
    this.clock = options.clock ?? Date.now;
  }
  status() {
    return {
      canUndo: this.undoGroups.length > 0,
      canRedo: this.redoGroups.length > 0,
      undo: this.undoGroups.length,
      redo: this.redoGroups.length,
      limit: this.limit,
      reset: this.resetNavigation,
    };
  }
  /** Detached diagnostics. Mutating this result never changes retained group membership. */
  groups() {
    const snapshot = (group: Group) =>
      structuredClone({
        group: group.id,
        actions: group.actions,
        footprint: group.footprints,
        selectionBefore: group.before,
        selectionAfter: group.after,
        previousControl: group.previousControl,
      });
    return { undo: this.undoGroups.map(snapshot), redo: this.redoGroups.map(snapshot) };
  }
  sealGroup(): void {
    this.open = undefined;
  }
  setLimit(limit: number): void {
    this.assertIdle();
    this.limit = limitValue(limit);
    this.evict();
  }
  reset(): void {
    this.assertIdle();
    this.sealGroup();
    this.undoGroups = [];
    this.redoGroups = [];
    this.resetNavigation = true;
  }
  private assertIdle() {
    if (this.busy) throw new Error('Recursive history operation is not allowed');
  }
  private next(): bigint {
    assertCounter(this.counter + 1n);
    return ++this.counter;
  }
  private evict() {
    while (this.undoGroups.length + this.redoGroups.length > this.limit) {
      const oldest = [...this.undoGroups, ...this.redoGroups].reduce((a, b) =>
        a.order < b.order ? a : b,
      );
      this.undoGroups = this.undoGroups.filter((g) => g !== oldest);
      this.redoGroups = this.redoGroups.filter((g) => g !== oldest);
      if (this.open?.group === oldest) this.sealGroup();
    }
  }
  edit<Input>(
    command: Edit<Input>,
    input: Input,
    options: ManagedEditOptions = {},
  ): LocalEditResult {
    this.assertIdle();
    this.busy = true;
    try {
      const p = this.driver.publication();
      const before = this.driver.capture(options),
        now = this.clock();
      const literal = input as InsertTextInput;
      const typing =
        options.typing === true &&
        command === insertText &&
        literal.from === (literal.to ?? literal.from) &&
        collapsedAt(p, before, before);
      let group =
        typing &&
        this.open &&
        now >= this.open.at &&
        now - this.open.at <= 1000 &&
        collapsedAt(p, this.open.group.after, before)
          ? this.open.group
          : undefined;
      if (!group) this.sealGroup();
      const counter = group?.id.sequence ?? this.next();
      const result = this.driver.edit(counter, command, input, options, (edit) => {
        if (!group) {
          group = {
            id: structuredClone(edit.envelope.groupId),
            order: counter,
            actions: [],
            footprints: [],
            before: edit.selectionBefore && structuredClone(edit.selectionBefore),
            emptyBefore: edit.emptyBefore,
            emptyAfter: edit.emptyAfter,
            previousControl: null,
          };
          this.undoGroups.push(group);
        }
        group.actions.push(structuredClone(edit.envelope.id));
        group.footprints.push(structuredClone(edit.footprint));
        this.redoGroups = [];
        this.resetNavigation = false;
        group.after = edit.selectionAfter && structuredClone(edit.selectionAfter);
        group.emptyAfter = edit.emptyAfter;
        if (typing && edit.envelope.effects.every((e) => e.type === 'InsertText'))
          this.open = { group, at: now };
        else this.sealGroup();
        this.evict();
      });

      return result;
    } finally {
      this.busy = false;
    }
  }
  editEmptyRoot(text: string): LocalEditResult {
    this.assertIdle();
    this.busy = true;
    this.sealGroup();
    try {
      this.driver.publication();
      const counter = this.next();
      const result = this.driver.empty(counter, text, (edit) => {
        const group: Group = {
          id: structuredClone(edit.envelope.groupId),
          order: counter,
          actions: [structuredClone(edit.envelope.id)],
          footprints: [structuredClone(edit.footprint)],
          emptyBefore: true,
          emptyAfter: edit.emptyAfter,
          previousControl: null,
        };
        this.undoGroups.push(group);
        this.redoGroups = [];
        this.resetNavigation = false;
        group.after = edit.selectionAfter && structuredClone(edit.selectionAfter);
        group.emptyAfter = edit.emptyAfter;
        this.evict();
      });

      return result;
    } finally {
      this.busy = false;
    }
  }
  undo(options: NavigationOptions = {}): NavigationResult {
    return this.navigate(false, options);
  }
  redo(options: NavigationOptions = {}): NavigationResult {
    return this.navigate(true, options);
  }
  private navigate(active: boolean, options: NavigationOptions): NavigationResult {
    this.assertIdle();
    this.busy = true;
    try {
      const p = this.driver.publication();
      this.sealGroup();
      if (options.scope && !validScope(p, options.scope)) return { state: 'invalid-scope' };
      const source = active ? this.redoGroups : this.undoGroups,
        destination = active ? this.undoGroups : this.redoGroups;
      for (let i = source.length - 1; i >= 0; i--) {
        const group = source[i]!;
        if (options.scope) {
          const classification = classifyFootprints(p, group.footprints, options.scope);
          if (classification === 'outside') continue;
          if (classification !== 'inside')
            return {
              state: 'blocked',
              group: structuredClone(group.id),
              reason: classification === 'mixed' ? 'mixed-footprint' : 'unresolved-footprint',
            };
        }
        const result = this.driver.control(
          this.next(),
          {
            type: 'SetGroupActive',
            group: group.id,
            actions: group.actions,
            active,
            previousControl: group.previousControl,
          },
          (id) => {
            group.previousControl = structuredClone(id);
            source.splice(i, 1);
            destination.push(group);
            this.resetNavigation = false;
          },
        );
        try {
          return {
            state: 'applied',
            action: structuredClone(result.action),
            group: structuredClone(group.id),
            restoration: resolveSelection(
              result.publication,
              active ? group.after : group.before,
              options.host ?? result.publication.value.view.root.origin,
              active ? group.emptyAfter : group.emptyBefore,
            ),
            version: this.driver.version(),
            session: this.local,
          };
        } catch (error) {
          throw new RetainedEditError(result.action, error);
        }
      }
      return { state: 'empty' };
    } finally {
      this.busy = false;
    }
  }
}
