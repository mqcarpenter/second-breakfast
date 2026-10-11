import { OutboxNotice } from "./OutboxNotice";
import { useOutbox } from "./useOutbox";

/** The online counterpart of `OfflineBar`: standing chrome while entries wait.
 *  Both occupy the shell's one top row, so the shell renders exactly one. */
export function OutboxBar() {
  const queue = useOutbox();
  if (queue.pending.length === 0) return null;
  return (
    <div className="jv-offline-bar jv-outbox-bar" role="status">
      <OutboxNotice queue={queue} />
    </div>
  );
}
