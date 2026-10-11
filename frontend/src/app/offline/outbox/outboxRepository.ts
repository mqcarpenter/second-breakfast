import { type DBSchema, type IDBPDatabase, openDB } from "idb";
import { uuid } from "../../../lib/uuid";
import { applyEvent, type OutboxEvent } from "./stateMachine";
import type { OutboxItem, OutboxMediaKind, OutboxMediaMeta } from "./types";

/**
 * Durable storage for the offline capture outbox.
 *
 * A database of its own, `journiv-outbox`, for the same reason the recordings
 * database has one: other modules own the version ladders of `journiv` (drafts)
 * and `journiv-offline` (read cache), and an outbox must never be wiped by their
 * migrations. Bytes are stored as `ArrayBuffer`, the value Safari's IndexedDB
 * stores reliably.
 *
 * Unlike the read cache, **failures here are loud.** The queue holds the only
 * copy of someone's writing, so a write that cannot be stored throws
 * `OutboxStorageError` instead of degrading quietly.
 */

type MediaRecord = { clientId: string; index: number; data: ArrayBuffer };

interface OutboxDb extends DBSchema {
  items: {
    key: string;
    value: OutboxItem;
    indexes: { "by-user": string };
  };
  media: {
    key: [string, number];
    value: MediaRecord;
  };
}

const DB_NAME = "journiv-outbox";
export const OUTBOX_DB_VERSION = 1;
/** Synced items stay visible briefly, then are pruned. */
export const SYNCED_RETENTION_MS = 24 * 60 * 60_000;

export class OutboxStorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OutboxStorageError";
  }
}

let connection: Promise<IDBPDatabase<OutboxDb>> | null = null;

function open(): Promise<IDBPDatabase<OutboxDb>> {
  if (connection) return connection;
  if (typeof indexedDB === "undefined") {
    return Promise.reject(
      new OutboxStorageError("This browser cannot store offline entries"),
    );
  }
  connection = openDB<OutboxDb>(DB_NAME, OUTBOX_DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore("items", { keyPath: "clientId" }).createIndex(
          "by-user",
          "userId",
        );
        db.createObjectStore("media", { keyPath: ["clientId", "index"] });
      }
    },
    blocking: () => void closeOutboxDb(),
  }).catch((cause: unknown) => {
    connection = null;
    throw new OutboxStorageError("Could not open offline storage", { cause });
  });
  return connection;
}

export async function closeOutboxDb() {
  const pending = connection;
  connection = null;
  if (!pending) return;
  try {
    (await pending).close();
  } catch {
    // Already gone.
  }
}

// -- change notification -----------------------------------------------------

const listeners = new Set<() => void>();
function notify() {
  for (const listener of listeners) listener();
}
/** Fires after any outbox write, so the queue UI can re-read. */
export function subscribeOutbox(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// -- helpers -----------------------------------------------------------------

export function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

export function mediaKindForMime(mimeType: string): OutboxMediaKind {
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "image";
}

async function guarded<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    if (cause instanceof OutboxStorageError) throw cause;
    throw new OutboxStorageError(what, { cause });
  }
}

// -- repository --------------------------------------------------------------

export type EnqueueInput = {
  userId: string;
  journalId: string;
  text: string;
  loggedAt: Date;
  timezone: string;
  latitude?: number | null;
  longitude?: number | null;
  files: File[];
  /** Tests pin the id; production lets it default. */
  clientId?: string;
};

export const outboxRepository = {
  /** Stores the item and every file in one transaction: all of it or none of it. */
  async enqueue(input: EnqueueInput): Promise<OutboxItem> {
    const now = new Date().toISOString();
    const buffers = await guarded("Could not read an attached file", () =>
      Promise.all(input.files.map((file) => blobToArrayBuffer(file))),
    );
    const media: OutboxMediaMeta[] = input.files.map((file, index) => ({
      index,
      kind: mediaKindForMime(file.type),
      fileName: file.name || `capture-${index + 1}`,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
      uploadedMediaId: null,
    }));
    const item: OutboxItem = {
      clientId: input.clientId ?? uuid(),
      userId: input.userId,
      journalId: input.journalId,
      text: input.text,
      loggedAtUtc: input.loggedAt.toISOString(),
      timezone: input.timezone,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      media,
      status: "queued",
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      momentId: null,
      createdAt: now,
      updatedAt: now,
      syncedAt: null,
    };
    await guarded("Could not save this entry on the device", async () => {
      const db = await open();
      const tx = db.transaction(["items", "media"], "readwrite");
      const items = tx.objectStore("items");
      const files = tx.objectStore("media");
      // Every request and the commit are awaited together, so a rejected add
      // aborts the whole transaction and surfaces as one handled error.
      await Promise.all([
        items.add(item),
        ...buffers.map((data, index) =>
          files.add({ clientId: item.clientId, index, data }),
        ),
        tx.done,
      ]);
    });
    notify();
    return item;
  },

  async get(clientId: string): Promise<OutboxItem | undefined> {
    return guarded("Could not read offline storage", async () =>
      (await open()).get("items", clientId),
    );
  },

  /** Oldest first, which is the order sync must replay them in. */
  async list(userId: string): Promise<OutboxItem[]> {
    return guarded("Could not read offline storage", async () => {
      const all = await (await open()).getAllFromIndex(
        "items",
        "by-user",
        userId,
      );
      return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    });
  },

  /** Applies a state-machine event and persists the result atomically. */
  async apply(
    clientId: string,
    event: OutboxEvent,
    now = new Date(),
  ): Promise<OutboxItem> {
    const next = await guarded("Could not update offline storage", async () => {
      const db = await open();
      const tx = db.transaction("items", "readwrite");
      try {
        const current = await tx.store.get(clientId);
        if (!current)
          throw new OutboxStorageError("That entry is no longer queued");
        const updated = applyEvent(current, event, now);
        await tx.store.put(updated);
        await tx.done;
        return updated;
      } catch (error) {
        // Abort so a rejected transition can never half-commit, and swallow the
        // abort's own completion rejection.
        tx.done.catch(() => undefined);
        try {
          tx.abort();
        } catch {
          // Already finished.
        }
        throw error;
      }
    });
    notify();
    return next;
  },

  async readFile(clientId: string, index: number): Promise<File> {
    return guarded("Could not read a queued file", async () => {
      const db = await open();
      const [item, record] = await Promise.all([
        db.get("items", clientId),
        db.get("media", [clientId, index]),
      ]);
      const meta = item?.media.find((m) => m.index === index);
      if (!meta || !record)
        throw new OutboxStorageError("A queued file is missing");
      return new File([record.data], meta.fileName, { type: meta.mimeType });
    });
  },

  /** Frees the bytes once everything is on the server. The item itself stays. */
  async deleteFiles(clientId: string): Promise<void> {
    await guarded("Could not clean up offline storage", async () => {
      const db = await open();
      const tx = db.transaction("media", "readwrite");
      let cursor = await tx.store.openCursor(
        IDBKeyRange.bound([clientId, 0], [clientId, Number.MAX_SAFE_INTEGER]),
      );
      while (cursor) {
        await cursor.delete();
        cursor = await cursor.continue();
      }
      await tx.done;
    });
    notify();
  },

  /** The user discarding an entry: removes the item and its bytes. */
  async remove(clientId: string): Promise<void> {
    await guarded("Could not remove the entry", async () => {
      const db = await open();
      const tx = db.transaction(["items", "media"], "readwrite");
      await tx.objectStore("items").delete(clientId);
      const media = tx.objectStore("media");
      let cursor = await media.openCursor(
        IDBKeyRange.bound([clientId, 0], [clientId, Number.MAX_SAFE_INTEGER]),
      );
      while (cursor) {
        await cursor.delete();
        cursor = await cursor.continue();
      }
      await tx.done;
    });
    notify();
  },

  /** A sync the OS killed leaves items stuck in "syncing". Put them back in the
   *  queue, keeping recorded progress. Call once at app launch. */
  async recoverInterrupted(userId: string, now = new Date()): Promise<number> {
    const items = await outboxRepository.list(userId);
    let recovered = 0;
    for (const item of items) {
      if (item.status === "syncing") {
        await outboxRepository.apply(
          item.clientId,
          { type: "interrupted" },
          now,
        );
        recovered += 1;
      }
    }
    return recovered;
  },

  async pruneSynced(userId: string, now = new Date()): Promise<number> {
    const items = await outboxRepository.list(userId);
    let pruned = 0;
    for (const item of items) {
      if (
        item.status === "synced" &&
        item.syncedAt &&
        now.getTime() - new Date(item.syncedAt).getTime() >= SYNCED_RETENTION_MS
      ) {
        await outboxRepository.remove(item.clientId);
        pruned += 1;
      }
    }
    return pruned;
  },
};
