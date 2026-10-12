/**
 * Offline capture outbox (docs/features/pwa.md, "Offline capture and sync").
 *
 * An item is one new entry written while the server was unreachable. It is the
 * only copy of that writing until it syncs, so the types describe exactly what
 * is needed to replay it: the idempotency key, the content, and the media.
 */

export type OutboxStatus = "queued" | "syncing" | "synced" | "failed";

export type OutboxMediaKind = "image" | "video" | "audio";

/** Everything about a staged file except its bytes, which live in their own
 *  object store so listing the queue never loads photos into memory. */
export type OutboxMediaMeta = {
  index: number;
  kind: OutboxMediaKind;
  fileName: string;
  mimeType: string;
  size: number;
  /** Set once the upload succeeded, so a resumed sync skips it. */
  uploadedMediaId: string | null;
};

/** A named place. Keys mirror the documented `location_json` the backend stores
 *  (name, locality, admin_area, country, timezone); coordinates live on the item. */
export type OutboxPlace = {
  name: string;
  locality?: string | null;
  admin_area?: string | null;
  country?: string | null;
  timezone?: string | null;
};

export type OutboxItem = {
  /** The client-generated idempotency key, sent as `client_id`. Also the primary key. */
  clientId: string;
  userId: string;
  journalId: string;
  text: string;
  loggedAtUtc: string;
  timezone: string;
  latitude: number | null;
  longitude: number | null;
  /** Optional: items queued before places existed do not have it. */
  place?: OutboxPlace | null;
  media: OutboxMediaMeta[];
  status: OutboxStatus;
  /** Sync attempts since the last manual retry. */
  attempts: number;
  /** Earliest time an automatic retry may run; null when due now. */
  nextAttemptAt: string | null;
  lastError: string | null;
  /** Server moment id once the create succeeded, so a resumed sync skips it. */
  momentId: string | null;
  createdAt: string;
  updatedAt: string;
  syncedAt: string | null;
};
