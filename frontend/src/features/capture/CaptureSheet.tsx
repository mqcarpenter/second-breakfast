import { useQueryClient } from "@tanstack/react-query";
import { FileAudio, ImagePlus, MapPin, Mic, Square, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sessionStore } from "../../api/auth/session";
import { queryKeys } from "../../api/query/keys";
import {
  OutboxStorageError,
  outboxRepository,
} from "../../app/offline/outbox/outboxRepository";
import {
  checkQuota,
  requestPersistence,
} from "../../app/offline/outbox/storage";
import { requestOutboxSync } from "../../app/offline/outbox/syncRuntime";
import { AppAdaptiveDialog } from "../../components/journiv/AppAdaptiveDialog";
import { AppConfirmDialog } from "../../components/journiv/AppConfirmDialog";
import { Button } from "../../components/ui/button";
import { IconButton } from "../../components/ui/icon-button";
import { NativeSelect } from "../../components/ui/native-select";
import { Textarea } from "../../components/ui/textarea";
import { toast } from "../../components/ui/toast";
import { browserTimeZone } from "../../lib/datetime";
import { groupJournals } from "../../lib/journalOrder";
import { useCompactViewport } from "../../lib/useCompactViewport";
import { useJournalLookup } from "../../lib/useJournalLookup";
import { formatDuration } from "../editor/dictationFormat";
import { mediaKindForMime } from "../../app/offline/outbox/outboxRepository";
import { uuid } from "../../lib/uuid";
import { useAudioCapture } from "./useAudioCapture";
import "./capture.css";

const LAST_JOURNAL_KEY = "journiv:capture:journal";

function readLastJournal(): string | null {
  try {
    return window.localStorage.getItem(LAST_JOURNAL_KEY);
  } catch {
    return null;
  }
}
function rememberJournal(id: string) {
  try {
    window.localStorage.setItem(LAST_JOURNAL_KEY, id);
  } catch {
    // A per-viewer convenience only.
  }
}

type Coordinates = { latitude: number; longitude: number };

function readLocation(): Promise<Coordinates> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("unsupported"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        }),
      reject,
      { timeout: 10_000, maximumAge: 60_000 },
    );
  });
}

/**
 * Offline capture (docs/features/pwa.md, "Offline capture and sync").
 *
 * Writes to the outbox only -- never to the network -- so it behaves identically
 * with or without a connection. The entry syncs when the server is reachable.
 * It is the same "substantial form" overlay as Quick Log; the parent remounts it
 * with a fresh `key` on every open so each capture starts clean.
 */
export function CaptureSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const compact = useCompactViewport();
  const queryClient = useQueryClient();
  const { journals, isLoading } = useJournalLookup();
  const active = useMemo(() => groupJournals(journals).active, [journals]);
  const userId = sessionStore.readHint()?.userId ?? null;

  // "Now", fixed for the life of this capture.
  const loggedAt = useMemo(() => new Date(), []);

  const [chosenJournal, setChosenJournal] = useState<string | null>(
    readLastJournal,
  );
  const journalId =
    chosenJournal && active.some((j) => j.id === chosenJournal)
      ? chosenJournal
      : (active[0]?.id ?? null);

  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<
    Array<{ id: string; file: File }>
  >([]);
  const files = useMemo(() => attachments.map((a) => a.file), [attachments]);
  const [location, setLocation] = useState<Coordinates | null>(null);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback((added: File[]) => {
    setError("");
    setAttachments((current) => [
      ...current,
      ...added.map((file) => ({ id: uuid(), file })),
    ]);
  }, []);
  const audio = useAudioCapture({ onRecorded: (file) => addFiles([file]) });

  // Object URLs for previews, released when the set changes or the sheet goes.
  const previews = useMemo(
    () =>
      attachments.map(({ id, file }) => ({
        id,
        file,
        kind: mediaKindForMime(file.type),
        url:
          file.type.startsWith("image/") || file.type.startsWith("video/")
            ? URL.createObjectURL(file)
            : null,
      })),
    [attachments],
  );
  useEffect(
    () => () => {
      for (const preview of previews)
        if (preview.url) URL.revokeObjectURL(preview.url);
    },
    [previews],
  );

  const hasContent = text.trim().length > 0 || files.length > 0;
  const busy = saving;
  const ready =
    hasContent &&
    Boolean(userId) &&
    Boolean(journalId) &&
    !busy &&
    !audio.recording;

  const requestClose = useCallback(
    (next: boolean) => {
      if (next) return onOpenChange(true);
      if (busy) return;
      if (hasContent || audio.recording) setDiscardOpen(true);
      else onOpenChange(false);
    },
    [busy, hasContent, audio.recording, onOpenChange],
  );

  const addLocation = async () => {
    setError("");
    setLocating(true);
    try {
      setLocation(await readLocation());
    } catch {
      setError("Couldn't get your location. Check that location access is on.");
    } finally {
      setLocating(false);
    }
  };

  const save = async () => {
    if (!ready || !userId || !journalId) return;
    setError("");
    setSaving(true);
    try {
      const total = files.reduce((sum, file) => sum + file.size, 0);
      const quota = await checkQuota(total);
      if (quota.level === "full") {
        setError(
          "There isn't enough free space on this device to keep this. Remove some attachments or free up space.",
        );
        return;
      }
      await outboxRepository.enqueue({
        userId,
        journalId,
        text,
        loggedAt,
        timezone: browserTimeZone(),
        latitude: location?.latitude,
        longitude: location?.longitude,
        files,
      });
      rememberJournal(journalId);
      // Real data exists now, so asking the browser not to evict it is meaningful.
      void requestPersistence();
      toast.add({
        title: "Saved on this device",
        description:
          quota.level === "near"
            ? "It will sync when you're connected. This device is running low on space."
            : "It will sync when you're connected.",
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.allMoments });
      onOpenChange(false);
      requestOutboxSync();
    } catch (caught) {
      setError(
        caught instanceof OutboxStorageError
          ? `${caught.message}. Your entry is still here, so you can try again.`
          : "Couldn't save this entry. Try again.",
      );
    } finally {
      setSaving(false);
    }
  };

  const footer = (
    <>
      {!compact && (
        <Button
          variant="ghost"
          onClick={() => requestClose(false)}
          disabled={busy}
        >
          Cancel
        </Button>
      )}
      <Button variant="default" onClick={() => void save()} disabled={!ready}>
        {saving ? "Saving…" : "Save entry"}
      </Button>
    </>
  );

  return (
    <>
      <AppAdaptiveDialog
        open={open}
        onOpenChange={requestClose}
        title="Capture"
        description="Saved on this device first, then sent to your journal when you're connected."
        size="md"
        dismissible={!busy}
        footer={footer}
      >
        <div className="jv-capture">
          {error && (
            <p className="jv-capture__error" role="alert">
              {error}
            </p>
          )}

          {!isLoading && active.length === 0 ? (
            <p className="jv-capture__error" role="alert">
              Your journals aren&rsquo;t available on this device yet. Open
              Trapper Keeper once while connected, then capture will work
              anywhere.
            </p>
          ) : (
            <div className="jv-capture__field">
              <label className="jv-label" htmlFor="capture-journal">
                Journal
              </label>
              <NativeSelect
                id="capture-journal"
                value={journalId ?? ""}
                onChange={(event) => setChosenJournal(event.target.value)}
                disabled={busy || active.length === 0}
              >
                {active.map((journal) => (
                  <option key={journal.id} value={journal.id}>
                    {journal.title}
                  </option>
                ))}
              </NativeSelect>
            </div>
          )}

          <div className="jv-capture__field">
            <label className="jv-label" htmlFor="capture-text">
              Entry
            </label>
            <Textarea
              id="capture-text"
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={6}
              placeholder="What's on your mind?"
              autoComplete="off"
              disabled={busy}
            />
          </div>

          <div className="jv-capture__field">
            <div className="jv-capture__head">
              <span className="jv-label">Photos, video and audio</span>
            </div>
            <div className="jv-capture__actions">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy || audio.recording}
              >
                <ImagePlus aria-hidden="true" size={15} />
                Add photos or video
              </Button>
              {audio.recording ? (
                <Button variant="outline" size="sm" onClick={audio.stop}>
                  <Square aria-hidden="true" size={15} />
                  Stop recording
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void audio.start()}
                  disabled={busy}
                >
                  <Mic aria-hidden="true" size={15} />
                  Record audio
                </Button>
              )}
            </div>
            {audio.recording && (
              <div className="jv-capture__recording" role="status">
                <span className="jv-capture__pulse" aria-hidden="true" />
                <span className="jv-label">
                  Recording {formatDuration(audio.elapsedMs)}
                </span>
              </div>
            )}
            {audio.error && (
              <p className="jv-capture__error" role="alert">
                {audio.error}
              </p>
            )}
            {previews.length > 0 && (
              <ul className="jv-capture__grid">
                {previews.map((preview) => (
                  <li key={preview.id} className="jv-capture__item">
                    {preview.url && preview.kind === "video" ? (
                      <video
                        className="jv-capture__thumb"
                        src={preview.url}
                        muted
                        playsInline
                      />
                    ) : preview.url ? (
                      <img
                        className="jv-capture__thumb"
                        src={preview.url}
                        alt={preview.file.name}
                      />
                    ) : (
                      <span
                        className="jv-capture__thumb jv-capture__thumb--audio"
                        role="img"
                        aria-label={preview.file.name}
                      >
                        <FileAudio aria-hidden="true" size={22} />
                      </span>
                    )}
                    <IconButton
                      label={`Remove ${preview.file.name}`}
                      size="sm"
                      className="jv-capture__remove"
                      onClick={() =>
                        setAttachments((current) =>
                          current.filter((a) => a.id !== preview.id),
                        )
                      }
                      disabled={busy}
                    >
                      <X aria-hidden="true" size={13} />
                    </IconButton>
                  </li>
                ))}
              </ul>
            )}
            <input
              ref={fileInputRef}
              className="sr-only"
              type="file"
              accept="image/*,video/*"
              multiple
              tabIndex={-1}
              aria-hidden="true"
              onChange={(event) => {
                const picked = [...(event.target.files ?? [])];
                event.target.value = "";
                if (picked.length) addFiles(picked);
              }}
            />
          </div>

          <div className="jv-capture__field">
            <span className="jv-label">Location</span>
            {location ? (
              <div className="jv-capture__location">
                <span className="jv-caption">
                  {location.latitude.toFixed(4)},{" "}
                  {location.longitude.toFixed(4)}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setLocation(null)}
                  disabled={busy}
                >
                  Remove location
                </Button>
              </div>
            ) : (
              <div className="jv-capture__actions">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void addLocation()}
                  disabled={busy || locating}
                >
                  <MapPin aria-hidden="true" size={15} />
                  {locating ? "Finding location…" : "Add my location"}
                </Button>
              </div>
            )}
          </div>
        </div>
      </AppAdaptiveDialog>

      <AppConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title="Discard this capture?"
        description="Nothing has been saved yet. It will be lost."
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        destructive
        onConfirm={() => {
          setDiscardOpen(false);
          onOpenChange(false);
        }}
      />
    </>
  );
}
