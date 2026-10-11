import { Button } from "../../components/ui/button";
import { useShell } from "../shell/shellContext";
import type { useOutbox } from "./useOutbox";

/** The queue summary shown in the shell's top bar: how many entries are waiting,
 *  whether any need attention, and the iOS storage-eviction warning. Renders
 *  nothing when the queue is empty.
 *
 *  The queue is passed in, not loaded here: the bar that hosts this decides
 *  whether to draw itself from the same snapshot, so it can never show an
 *  empty container while this is still loading. */
export function OutboxNotice({
  queue,
}: {
  queue: ReturnType<typeof useOutbox>;
}) {
  const { pending, failed, stale } = queue;
  const shell = useShell();
  if (pending.length === 0) return null;

  const waiting = pending.length - failed.length;
  const parts: string[] = [];
  if (waiting > 0)
    parts.push(
      `${waiting} ${waiting === 1 ? "entry" : "entries"} waiting to sync.`,
    );
  if (failed.length > 0)
    parts.push(
      `${failed.length} ${failed.length === 1 ? "entry needs" : "entries need"} attention.`,
    );
  if (stale.length > 0)
    parts.push(
      "Some have been waiting over 7 days. Connect soon: iOS can remove saved data from apps left unopened.",
    );

  return (
    <>
      <span className="text-sm text-foreground">{parts.join(" ")}</span>
      <Button variant="outline" size="sm" onClick={shell.openOutbox}>
        Review
      </Button>
    </>
  );
}
