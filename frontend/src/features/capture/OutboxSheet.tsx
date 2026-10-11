import { formatDistanceToNow } from "date-fns";
import { CloudCheck, CloudUpload, RotateCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { outboxRepository } from "../../app/offline/outbox/outboxRepository";
import { requestOutboxSync } from "../../app/offline/outbox/syncRuntime";
import { isStale } from "../../app/offline/outbox/stateMachine";
import type { OutboxItem } from "../../app/offline/outbox/types";
import { AppAdaptiveDialog } from "../../components/journiv/AppAdaptiveDialog";
import { AppConfirmDialog } from "../../components/journiv/AppConfirmDialog";
import { StatusView } from "../../components/journiv/StatusView";
import { Button } from "../../components/ui/button";
import { useCompactViewport } from "../../lib/useCompactViewport";
import { useOutbox } from "./useOutbox";
import "./capture.css";

function summary(item: OutboxItem): string {
  const firstLine = item.text.trim().split("\n")[0] ?? "";
  if (firstLine) {
    return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
  }
  return "Media-only entry";
}

function mediaSummary(item: OutboxItem): string {
  const count = (kind: string) =>
    item.media.filter((m) => m.kind === kind).length;
  const parts: string[] = [];
  const photos = count("image");
  const videos = count("video");
  const audio = count("audio");
  if (photos) parts.push(`${photos} photo${photos === 1 ? "" : "s"}`);
  if (videos) parts.push(`${videos} video${videos === 1 ? "" : "s"}`);
  if (audio) parts.push(`${audio} audio`);
  return parts.join(", ");
}

function statusLabel(item: OutboxItem): string {
  switch (item.status) {
    case "failed":
      return "Needs attention";
    case "syncing":
      return "Syncing…";
    default:
      return "Waiting to sync";
  }
}

/** Everything still on this device, with retry and discard (docs/features/pwa.md). */
export function OutboxSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const compact = useCompactViewport();
  const { pending, synced } = useOutbox();
  const [discarding, setDiscarding] = useState<OutboxItem | null>(null);
  const [error, setError] = useState("");
  const now = new Date();

  const retry = async (item: OutboxItem) => {
    setError("");
    try {
      await outboxRepository.apply(item.clientId, { type: "retry" });
      requestOutboxSync();
    } catch {
      setError("Couldn't retry that entry. Try again.");
    }
  };

  const discard = async () => {
    const item = discarding;
    setDiscarding(null);
    if (!item) return;
    setError("");
    try {
      await outboxRepository.remove(item.clientId);
    } catch {
      setError("Couldn't discard that entry. Try again.");
    }
  };

  return (
    <>
      <AppAdaptiveDialog
        open={open}
        onOpenChange={onOpenChange}
        title="Waiting to sync"
        description="These entries are saved on this device and will be sent to your journal when it's reachable."
        size="md"
        footer={
          <>
            {!compact && (
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            )}
            <Button
              variant="default"
              onClick={requestOutboxSync}
              disabled={pending.length === 0}
            >
              <CloudUpload aria-hidden="true" size={15} />
              Sync now
            </Button>
          </>
        }
      >
        {error && (
          <p className="jv-capture__error" role="alert">
            {error}
          </p>
        )}
        {pending.length === 0 && synced.length === 0 ? (
          <StatusView
            icon={<CloudUpload size={22} />}
            title="Nothing to sync"
            description="Entries you capture on this device show up here until the server confirms them."
          />
        ) : pending.length === 0 ? (
          <StatusView
            icon={<CloudCheck size={22} />}
            title="Everything is synced"
            description="Nothing is waiting on this device."
          />
        ) : (
          <ul className="jv-outbox__list">
            {pending.map((item) => (
              <li key={item.clientId} className="jv-outbox__row">
                <div className="jv-outbox__main">
                  <span className="jv-label jv-truncate">{summary(item)}</span>
                  <span className="jv-caption">
                    {formatDistanceToNow(new Date(item.createdAt), {
                      addSuffix: true,
                    })}
                    {mediaSummary(item) ? ` · ${mediaSummary(item)}` : ""}
                    {" · "}
                    {statusLabel(item)}
                  </span>
                  {item.status === "failed" && item.lastError && (
                    <span className="jv-outbox__error" role="alert">
                      {item.lastError}
                    </span>
                  )}
                  {isStale(item, now) && (
                    <span className="jv-caption">
                      Waiting over 7 days. Connect soon so it isn&rsquo;t lost.
                    </span>
                  )}
                </div>
                <div className="jv-outbox__actions">
                  {item.status === "failed" && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void retry(item)}
                    >
                      <RotateCw aria-hidden="true" size={14} />
                      Retry
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setDiscarding(item)}
                    disabled={item.status === "syncing"}
                  >
                    <Trash2 aria-hidden="true" size={14} />
                    Discard
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {synced.length > 0 && (
          <section aria-label="Recently synced" className="jv-outbox__synced">
            <h3 className="jv-label">Recently synced</h3>
            <ul className="jv-outbox__list">
              {synced.map((item) => (
                <li key={item.clientId} className="jv-outbox__row">
                  <div className="jv-outbox__main">
                    <span className="jv-label jv-truncate">
                      {summary(item)}
                    </span>
                    <span className="jv-caption jv-outbox__confirmed">
                      <CloudCheck aria-hidden="true" size={13} />
                      Saved to your journal{" "}
                      {item.syncedAt
                        ? formatDistanceToNow(new Date(item.syncedAt), {
                            addSuffix: true,
                          })
                        : ""}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </AppAdaptiveDialog>

      <AppConfirmDialog
        open={discarding !== null}
        onOpenChange={(next) => {
          if (!next) setDiscarding(null);
        }}
        title="Discard this entry?"
        description={
          discarding?.momentId
            ? "Its text is already saved in your journal. Only the photos, video and audio still waiting on this device will be lost."
            : "It hasn't reached your journal yet. This can't be undone."
        }
        confirmLabel="Discard"
        cancelLabel="Keep"
        destructive
        onConfirm={() => void discard()}
      />
    </>
  );
}
