import type { ActionEnvelope, NodeId, RunId, TapeId } from '../contracts.js';
import type { ReadySequence } from '../authoring/ready-source.js';
import type { NativeView } from '../ingest/publication.js';
import type { OwnershipResult } from '../ownership/ownership.js';
import type { Activity, EffectRef } from '../visibility/activity.js';
import type { projectWithActivity } from '../projection/project.js';
import type { BirthContent } from '../projection/types.js';

type Projection = ReturnType<typeof projectWithActivity>;
/** C's narrow consumer of A's resource contract. Only an exact, already
 * validated producer result may enter this seam. It is not peer-supplied evidence
 * or an author-validation exemption. Production wiring belongs to the parent
 * after B's producer is reviewed; C tests use controlled snapshot differences.
 */
export interface StructuralProjectionChange {
  readonly base: Projection;
  readonly family: 'text' | 'split' | 'join' | 'control' | 'placement';
  readonly replay: { readonly from: number; readonly to: number; readonly reason: string };
  readonly action: ActionEnvelope;
  readonly revision: object;
  readonly actions: ReadySequence;
  readonly semanticChanges: readonly ActionEnvelope[];
  readonly native: NativeView;
  readonly activity: Activity;
  readonly structure: { readonly value: OwnershipResult; assertCurrent?(): void; commit(): void };
  /** Complete before/after flow/header readers, including ghosts and removals. */
  readonly nodes: readonly NodeId[];
  /** Former/new raw containers whose child sequences changed. */
  readonly containers: readonly NodeId[];
  readonly rootRuns: ReadonlyMap<string, RunId>;
  readonly tapes: readonly TapeId[];
  readonly nativeTapes: readonly TapeId[];
  /** Complete final destination witnesses for every changed node. */
  readonly requirements: ReadonlyMap<string, readonly EffectRef[]>;
  /** Exact allocating-closure coverage for newly retained nodes. */
  readonly birthContent: readonly BirthContent[];
}
