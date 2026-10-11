import type { OutboxItem } from "./types";

/**
 * The outbox lifecycle as pure functions, so every rule is testable without a
 * browser or a database:
 *
 *   queued --start--> syncing --succeeded--> synced
 *      ^                 |
 *      |<--interrupted---+--retryableFailure--> queued (backoff) | failed
 *      |                 +--permanentFailure--> failed
 *   failed --retry--> queued
 *
 * `momentCreated` and `mediaUploaded` record progress inside `syncing`, which
 * is what lets a sync killed halfway resume without repeating finished work.
 */

/** After this many automatic attempts an item stops retrying by itself and
 *  waits for the user. */
export const MAX_AUTO_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 15 * 60_000;
/** iOS may evict web-app storage after long disuse (docs/features/pwa.md). */
export const STALE_AFTER_MS = 7 * 24 * 60 * 60_000;

export class OutboxTransitionError extends Error {
  constructor(from: string, event: string) {
    super(`Cannot apply "${event}" to an outbox item that is ${from}`);
    this.name = "OutboxTransitionError";
  }
}

export type OutboxEvent =
  | { type: "start" }
  | { type: "momentCreated"; momentId: string }
  | { type: "mediaUploaded"; index: number; mediaId: string }
  | { type: "succeeded" }
  | { type: "retryableFailure"; error: string }
  | { type: "permanentFailure"; error: string }
  | { type: "interrupted" }
  | { type: "retry" };

/** 5s, 10s, 20s ... capped at 15 minutes. `attempts` is 1 after the first try. */
export function backoffMs(attempts: number): number {
  if (attempts <= 0) return 0;
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempts - 1));
}

export function isDue(item: OutboxItem, now: Date): boolean {
  if (item.status !== "queued") return false;
  return !item.nextAttemptAt || new Date(item.nextAttemptAt) <= now;
}

export function isStale(item: OutboxItem, now: Date): boolean {
  if (item.status === "synced") return false;
  return now.getTime() - new Date(item.createdAt).getTime() >= STALE_AFTER_MS;
}

export function applyEvent(
  item: OutboxItem,
  event: OutboxEvent,
  now: Date,
): OutboxItem {
  const stamp = now.toISOString();
  const touch = (changes: Partial<OutboxItem>): OutboxItem => ({
    ...item,
    ...changes,
    updatedAt: stamp,
  });
  const expectStatus = (...allowed: OutboxItem["status"][]) => {
    if (!allowed.includes(item.status))
      throw new OutboxTransitionError(item.status, event.type);
  };

  switch (event.type) {
    case "start":
      expectStatus("queued");
      return touch({
        status: "syncing",
        attempts: item.attempts + 1,
        nextAttemptAt: null,
      });
    case "momentCreated":
      expectStatus("syncing");
      return touch({ momentId: event.momentId });
    case "mediaUploaded": {
      expectStatus("syncing");
      if (!item.media.some((m) => m.index === event.index))
        throw new OutboxTransitionError(
          `missing media ${event.index}`,
          event.type,
        );
      return touch({
        media: item.media.map((m) =>
          m.index === event.index
            ? { ...m, uploadedMediaId: event.mediaId }
            : m,
        ),
      });
    }
    case "succeeded":
      expectStatus("syncing");
      if (!item.momentId || item.media.some((m) => !m.uploadedMediaId))
        throw new OutboxTransitionError("incomplete", event.type);
      return touch({
        status: "synced",
        syncedAt: stamp,
        lastError: null,
        nextAttemptAt: null,
      });
    case "retryableFailure":
      expectStatus("syncing");
      if (item.attempts >= MAX_AUTO_ATTEMPTS) {
        return touch({
          status: "failed",
          lastError: event.error,
          nextAttemptAt: null,
        });
      }
      return touch({
        status: "queued",
        lastError: event.error,
        nextAttemptAt: new Date(
          now.getTime() + backoffMs(item.attempts),
        ).toISOString(),
      });
    case "permanentFailure":
      expectStatus("syncing");
      return touch({
        status: "failed",
        lastError: event.error,
        nextAttemptAt: null,
      });
    case "interrupted":
      // The app was killed, or the server or session went away mid-sync. Not the
      // item's fault, so the attempt it consumed is refunded and no backoff
      // applies; recorded progress is kept.
      expectStatus("syncing");
      return touch({
        status: "queued",
        attempts: Math.max(0, item.attempts - 1),
        nextAttemptAt: null,
      });
    case "retry":
      expectStatus("failed");
      return touch({
        status: "queued",
        attempts: 0,
        nextAttemptAt: null,
        lastError: null,
      });
  }
}
