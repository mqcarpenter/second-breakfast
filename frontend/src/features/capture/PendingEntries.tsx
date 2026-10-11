import { TriangleAlert, Clock } from "lucide-react";
import { Badge } from "../../components/ui/badge";
import { formatTimeOfDay } from "../../lib/datetime";
import { truncate } from "../../lib/moment";
import { useShell } from "../shell/shellContext";
import { useOutbox } from "./useOutbox";

/**
 * Entries written on this device that the server has not confirmed yet, shown
 * at the top of the Timeline so a capture is never invisible after Save.
 *
 * Same row grammar as a real Moment (time, label, excerpt) so it reads as "this
 * entry, not saved yet". When the server confirms it, this row disappears and
 * the real Moment appears below with its "Synced from device" marker -- the
 * change of marker is the confirmation. Tapping opens the review sheet.
 *
 * `journalId` limits the list to a journal-scoped Timeline; omit it for all.
 */
export function PendingEntries({ journalId }: { journalId?: string }) {
  const { pending } = useOutbox();
  const shell = useShell();
  const rows = journalId
    ? pending.filter((item) => item.journalId === journalId)
    : pending;
  if (rows.length === 0) return null;

  return (
    <div className="jv-list__group">
      <h2 className="jv-list__day">Waiting to sync</h2>
      {rows.map((item) => {
        const failed = item.status === "failed";
        const text = item.text.trim();
        return (
          <button
            key={item.clientId}
            type="button"
            className="jv-moment jv-moment--pending"
            onClick={shell.openOutbox}
          >
            <span className="jv-moment__body">
              <span className="jv-moment__lead">
                <span className="jv-meta">
                  {formatTimeOfDay(item.loggedAtUtc, item.timezone)}
                </span>
                <Badge variant="outline">
                  {failed ? (
                    <TriangleAlert aria-hidden="true" size={12} />
                  ) : (
                    <Clock aria-hidden="true" size={12} />
                  )}
                  {failed ? "Needs attention" : "On this device"}
                </Badge>
              </span>
              <span className="jv-moment__prose jv-clamp-2">
                {text ? truncate(text, 200) : "Photos, video or audio"}
              </span>
              {failed && item.lastError && (
                <span className="jv-caption" role="alert">
                  {item.lastError}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
