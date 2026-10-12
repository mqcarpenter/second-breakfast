import { ApiError } from "../../../api/client/errors";
import type { MomentCreate } from "../../../api/generated/types.gen";
import {
  MediaUploadError,
  uploadErrorMessage,
} from "../../../features/editor/mediaUpload";
import { OutboxStorageError, outboxRepository } from "./outboxRepository";
import { isDue } from "./stateMachine";
import type { OutboxItem, OutboxPlace } from "./types";

/**
 * Replays queued entries to the server (docs/features/pwa.md, "Offline capture
 * and sync").
 *
 * Every external effect is injected, so the whole protocol -- including a kill
 * at any step -- is testable without a browser or a server.
 *
 * Per item, in order: create the Moment (idempotent via `client_id`), upload
 * each file (idempotent per Moment by checksum), then mark synced. Progress is
 * recorded after each step, so a sync killed halfway resumes where it stopped,
 * and repeating a step the server already finished is harmless.
 */

export type SyncDeps = {
  /** True when the server answers its health endpoint. */
  probe: () => Promise<boolean>;
  /** True when a usable access token exists, refreshing it if it must. */
  ensureSession: () => Promise<boolean>;
  createMoment: (body: MomentCreate) => Promise<{ id: string }>;
  uploadFile: (file: File, momentId: string) => Promise<{ id: string }>;
  /** Best-effort: names a GPS-only capture once the server is reachable. A
   *  failure or a null result just leaves the entry with coordinates. */
  resolvePlace?: (
    latitude: number,
    longitude: number,
  ) => Promise<OutboxPlace | null>;
  now?: () => Date;
};

export type SyncOutcome =
  | "idle" // nothing to do
  | "offline" // the server could not be reached
  | "signed-out" // no usable session
  | "done"; // every due item was attempted

export type SyncReport = {
  outcome: SyncOutcome;
  synced: number;
  failed: number;
  /** Items still waiting (queued or failed) after this run. */
  remaining: number;
};

/**
 * How a failure should be treated.
 *
 * - connectivity: the server could not be reached; not the item's fault, stop.
 * - auth: the session is unusable; not the item's fault, stop.
 * - retryable: the server hiccuped; back off and try again.
 * - permanent: the server rejected the content; retrying cannot help.
 */
export type FailureClass = "connectivity" | "auth" | "retryable" | "permanent";

export function classifyFailure(error: unknown): FailureClass {
  if (error instanceof MediaUploadError) {
    switch (error.kind) {
      case "network":
        return "connectivity";
      case "unauthorized":
        return "auth";
      case "server":
      case "aborted":
        return "retryable";
      default:
        return "permanent";
    }
  }
  if (error instanceof ApiError) {
    const status = error.status;
    if (status === undefined) return "connectivity";
    if (status === 401 || status === 403) return "auth";
    if (status === 408 || status === 429 || status >= 500) return "retryable";
    return "permanent";
  }
  // A failed fetch surfaces as a TypeError with no response.
  if (error instanceof TypeError) return "connectivity";
  return "retryable";
}

/** A human sentence for the queue UI. Never the server's own text. */
export function describeFailure(error: unknown, fileName?: string): string {
  const target = fileName ? ` (${fileName})` : "";
  if (error instanceof MediaUploadError)
    return `${uploadErrorMessage(error)}${target}`;
  if (error instanceof ApiError) {
    if (error.status === 404)
      return "The journal or entry this was written for no longer exists.";
    if (error.status && error.status < 500)
      return `The server rejected this entry (${error.status}).`;
    return "The server had a problem. It will try again.";
  }
  if (error instanceof OutboxStorageError) return error.message;
  return "Something went wrong while syncing. It will try again.";
}

export function buildMomentBody(item: OutboxItem): MomentCreate {
  const text = item.text.trim();
  const body: MomentCreate = {
    client_id: item.clientId,
    logged_at_utc: item.loggedAtUtc,
    logged_timezone: item.timezone,
  };
  const hasCoordinates = item.latitude != null && item.longitude != null;
  if (hasCoordinates) {
    body.latitude = item.latitude;
    body.longitude = item.longitude;
  }
  // `location_json` uses the backend's documented keys only; the reader labels
  // an entry from name, locality, admin_area or country.
  if (item.place?.name) {
    body.location_json = {
      ...item.place,
      ...(hasCoordinates
        ? { latitude: item.latitude, longitude: item.longitude }
        : {}),
    };
  }
  // Media-only captures become media-only Moments, like Quick Log.
  if (text) {
    body.entry = {
      journal_id: item.journalId,
      content_delta: { ops: [{ insert: `${text}\n` }] },
    };
  }
  return body;
}

export function createSyncEngine(
  deps: SyncDeps,
  repo: Pick<
    typeof outboxRepository,
    "list" | "apply" | "readFile" | "deleteFiles" | "recoverInterrupted"
  > = outboxRepository,
) {
  const now = () => (deps.now ? deps.now() : new Date());
  let inFlight: Promise<SyncReport> | null = null;

  async function remainingCount(userId: string): Promise<number> {
    const items = await repo.list(userId);
    return items.filter((i) => i.status === "queued" || i.status === "failed")
      .length;
  }

  /** "offline" and "signed-out" end the run: the server or session is gone, which
   *  is not the item's fault. "retrying" means requeued with backoff. */
  async function syncItem(
    item: OutboxItem,
  ): Promise<"synced" | "failed" | "retrying" | "offline" | "signed-out"> {
    const id = item.clientId;
    let current = await repo.apply(id, { type: "start" }, now());
    let activeFile: string | undefined;
    try {
      if (!current.momentId) {
        let toCreate = current;
        if (
          !current.place &&
          current.latitude != null &&
          current.longitude != null &&
          deps.resolvePlace
        ) {
          try {
            const place = await deps.resolvePlace(
              current.latitude,
              current.longitude,
            );
            if (place) toCreate = { ...current, place };
          } catch {
            // Naming the place is a courtesy; coordinates alone are fine.
          }
        }
        const moment = await deps.createMoment(buildMomentBody(toCreate));
        current = await repo.apply(
          id,
          { type: "momentCreated", momentId: moment.id },
          now(),
        );
      }
      const momentId = current.momentId as string;
      for (const meta of current.media) {
        if (meta.uploadedMediaId) continue;
        activeFile = meta.fileName;
        const file = await repo.readFile(id, meta.index);
        const uploaded = await deps.uploadFile(file, momentId);
        current = await repo.apply(
          id,
          { type: "mediaUploaded", index: meta.index, mediaId: uploaded.id },
          now(),
        );
      }
      activeFile = undefined;
      await repo.apply(id, { type: "succeeded" }, now());
    } catch (error) {
      const kind = classifyFailure(error);
      if (kind === "connectivity" || kind === "auth") {
        await repo.apply(id, { type: "interrupted" }, now());
        return kind === "auth" ? "signed-out" : "offline";
      }
      const message = describeFailure(error, activeFile);
      if (kind === "permanent") {
        await repo.apply(
          id,
          { type: "permanentFailure", error: message },
          now(),
        );
        return "failed";
      }
      const after = await repo.apply(
        id,
        { type: "retryableFailure", error: message },
        now(),
      );
      return after.status === "failed" ? "failed" : "retrying";
    }
    // Bytes are no longer needed. A cleanup failure must not undo a real sync.
    try {
      await repo.deleteFiles(id);
    } catch {
      // The item is already synced; leftover bytes are pruned with it.
    }
    return "synced";
  }

  async function run(userId: string): Promise<SyncReport> {
    await repo.recoverInterrupted(userId, now());
    const due = (await repo.list(userId)).filter((i) => isDue(i, now()));
    if (due.length === 0) {
      return {
        outcome: "idle",
        synced: 0,
        failed: 0,
        remaining: await remainingCount(userId),
      };
    }
    if (!(await deps.probe())) {
      return {
        outcome: "offline",
        synced: 0,
        failed: 0,
        remaining: await remainingCount(userId),
      };
    }
    if (!(await deps.ensureSession())) {
      return {
        outcome: "signed-out",
        synced: 0,
        failed: 0,
        remaining: await remainingCount(userId),
      };
    }

    let synced = 0;
    let failed = 0;
    let outcome: SyncOutcome = "done";
    for (const item of due) {
      const result = await syncItem(item);
      if (result === "synced") synced += 1;
      else if (result === "failed") failed += 1;
      else if (result === "offline" || result === "signed-out") {
        outcome = result;
        break;
      }
    }
    return { outcome, synced, failed, remaining: await remainingCount(userId) };
  }

  return {
    /** Single-flight: a second call while one is running shares its result. */
    sync(userId: string): Promise<SyncReport> {
      if (!inFlight) {
        inFlight = run(userId).finally(() => {
          inFlight = null;
        });
      }
      return inFlight;
    },
  };
}
