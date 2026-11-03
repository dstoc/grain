import { CanonicalWriter } from '../../markdown/canonical/writer.js';
import type { AcceptedAction, ActionOptions } from '../../markdown/canonical/action-types.js';
import type { EditSelection } from '../../markdown/semantic/selection.js';
import type { NodeId } from '../../markdown/semantic/types.js';
import type { Edit } from '../outcomes.js';
import { prepareEdit } from '../prepare-edit.js';

export function runCommand<Input>(
  writer: CanonicalWriter,
  options: ActionOptions,
  scopeRoot: NodeId,
  selectionBefore: EditSelection | undefined,
  command: Edit<Input>,
  input: Input,
): AcceptedAction | undefined {
  const sessionId = options.sessionId ?? 'local';
  writer.admitSession(sessionId);
  const prepared = prepareEdit(writer, options, scopeRoot, selectionBefore, command, input);
  if (!prepared) return undefined;
  const request = prepared.request;
  const result = writer.apply(request, {
    sessionId,
    authorityEpoch: request.authorityEpoch,
    sessionSequence: request.sessionSequence,
  });
  if (result.status === 'pending') return writer.publish(result.pending);
  if (result.status === 'duplicate') return result.accepted;
  throw new Error(`edit was not accepted: ${result.status}`);
}
