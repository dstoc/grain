import type { ActionStore } from '../actions/store.js';
import type { ActionEnvelope } from '../contracts.js';
import type { ProjectionStatus, PublishedProjection } from '../ingest/publication.js';
import type { Computation } from '../ingest/work.js';
import type { projectMarkdown } from '../projection/project.js';

/** Local editing needs one complete publication and exact author certification.
 * Reader selection is private to this replica, outside all synchronized metadata.
 */
export interface AuthoringDocument {
  readonly commandMode?: 'overlay';
  readonly store: Pick<ActionStore, 'snapshot' | 'append' | 'encodeUpdate' | 'factsVersion'>;
  readonly publication: {
    status(): ProjectionStatus<ReturnType<typeof projectMarkdown>>;
    refresh(
      operations?: number,
    ): Computation<PublishedProjection<ReturnType<typeof projectMarkdown>>>;
  };
  certifyLocal(action: ActionEnvelope): void;
}
