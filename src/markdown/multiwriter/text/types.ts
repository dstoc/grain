import type {
  ActionEnvelope,
  Affinity,
  Allocation,
  MarkerId,
  NativeId,
  NativeTextRange,
  TapeId,
} from '../contracts.js';

/** The native subset of an envelope. Other allocation kinds are ignored by this adapter. */
export type NativeBody = Pick<
  ActionEnvelope,
  'allocations' | 'nativeInsertUpdates' | 'nativeManifest'
>;
export type TapeAllocation = Extract<Allocation, { type: 'tape' }>;
export type MarkerAllocation = Extract<Allocation, { type: 'marker' }>;

/** Indexes count UTF-16 units and permanent embeds, not projected/visible characters. */
export type NativeInsertion =
  | {
      readonly type: 'createTape';
      readonly tape: TapeId;
      readonly start: MarkerId;
      readonly end: MarkerId;
    }
  | { readonly type: 'text'; readonly tape: TapeId; readonly index: number; readonly text: string }
  | {
      readonly type: 'marker';
      readonly tape: TapeId;
      readonly index: number;
      readonly marker: MarkerId;
      readonly affinity: Affinity;
    };

export type TapePart =
  | {
      readonly type: 'text';
      readonly index: number;
      readonly native: NativeId;
      readonly text: string;
    }
  | {
      readonly type: 'marker';
      readonly index: number;
      readonly native: NativeId;
      readonly marker: MarkerId;
      readonly affinity: Affinity;
    };
export interface TapeSnapshot {
  readonly tape: TapeId;
  readonly length: number;
  readonly parts: readonly TapePart[];
}
export interface PreparedNativeBody {
  /** Own update events only. Append the enclosing envelope before calling commit(). */
  readonly body: NativeBody;
  commit(): void;
  /** Rebuilds from retained published bodies with a fresh native client. */
  abort(): void;
}
export interface LocatedText {
  readonly index: number;
  readonly text: string;
  readonly range: NativeTextRange;
}
