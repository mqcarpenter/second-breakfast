import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  blobToArrayBuffer,
  closeOutboxDb,
  outboxRepository,
  OutboxStorageError,
  subscribeOutbox,
  SYNCED_RETENTION_MS,
} from "./outboxRepository";

const T0 = new Date("2026-10-11T12:00:00.000Z");

const file = (name: string, type: string, ...bytes: number[]) =>
  new File([new Uint8Array(bytes)], name, { type });

const base = (
  over: Partial<Parameters<typeof outboxRepository.enqueue>[0]> = {},
) => ({
  userId: "u1",
  journalId: "j1",
  text: "hello world",
  loggedAt: T0,
  timezone: "America/New_York",
  files: [] as File[],
  ...over,
});

afterEach(async () => {
  await closeOutboxDb();
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase("journiv-outbox");
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
});

describe("enqueue", () => {
  it("stores the item queued with its idempotency key", async () => {
    const item = await outboxRepository.enqueue(base({ clientId: "client-1" }));
    expect(item).toMatchObject({
      clientId: "client-1",
      status: "queued",
      attempts: 0,
      momentId: null,
      loggedAtUtc: T0.toISOString(),
      latitude: null,
    });
    expect(await outboxRepository.get("client-1")).toEqual(item);
  });

  it("round-trips file bytes exactly and classifies the kind", async () => {
    const item = await outboxRepository.enqueue(
      base({
        files: [
          file("a.jpg", "image/jpeg", 1, 2, 3),
          file("b.mov", "video/quicktime", 4),
          file("c.m4a", "audio/mp4", 5, 6),
        ],
      }),
    );
    expect(item.media.map((m) => m.kind)).toEqual(["image", "video", "audio"]);
    const restored = await outboxRepository.readFile(item.clientId, 2);
    expect(restored.name).toBe("c.m4a");
    expect(restored.type).toBe("audio/mp4");
    expect(
      Array.from(new Uint8Array(await blobToArrayBuffer(restored))),
    ).toEqual([5, 6]);
  });

  it("is all-or-nothing: a duplicate key stores neither item nor files", async () => {
    await outboxRepository.enqueue(
      base({ clientId: "dup", files: [file("a.jpg", "image/jpeg", 1)] }),
    );
    await expect(
      outboxRepository.enqueue(
        base({ clientId: "dup", files: [file("z.jpg", "image/jpeg", 9)] }),
      ),
    ).rejects.toBeInstanceOf(OutboxStorageError);
    const kept = await outboxRepository.readFile("dup", 0);
    expect(kept.name).toBe("a.jpg");
    expect(Array.from(new Uint8Array(await blobToArrayBuffer(kept)))).toEqual([
      1,
    ]);
  });
});

describe("list", () => {
  it("returns only the user's items, oldest first", async () => {
    // Only Date: fake-indexeddb relies on setImmediate, which full fake timers freeze.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-11T10:00:00.000Z"));
      await outboxRepository.enqueue(base({ clientId: "old" }));
      vi.setSystemTime(new Date("2026-10-11T11:00:00.000Z"));
      await outboxRepository.enqueue(base({ clientId: "new" }));
      await outboxRepository.enqueue(base({ clientId: "other", userId: "u2" }));
    } finally {
      vi.useRealTimers();
    }
    const items = await outboxRepository.list("u1");
    expect(items.map((i) => i.clientId)).toEqual(["old", "new"]);
  });
});

describe("apply", () => {
  it("persists transitions and rejects illegal ones", async () => {
    const { clientId } = await outboxRepository.enqueue(base());
    const syncing = await outboxRepository.apply(
      clientId,
      { type: "start" },
      T0,
    );
    expect(syncing.status).toBe("syncing");
    expect((await outboxRepository.get(clientId))?.attempts).toBe(1);
    await expect(
      outboxRepository.apply(clientId, { type: "retry" }, T0),
    ).rejects.toBeInstanceOf(Error);
    expect((await outboxRepository.get(clientId))?.status).toBe("syncing");
  });

  it("fails loudly when the entry is gone", async () => {
    await expect(
      outboxRepository.apply("missing", { type: "start" }, T0),
    ).rejects.toBeInstanceOf(OutboxStorageError);
  });
});

describe("crash recovery", () => {
  it("requeues items stranded in syncing and keeps recorded progress", async () => {
    const { clientId } = await outboxRepository.enqueue(
      base({ files: [file("a.jpg", "image/jpeg", 1)] }),
    );
    await outboxRepository.apply(clientId, { type: "start" }, T0);
    await outboxRepository.apply(
      clientId,
      { type: "momentCreated", momentId: "m1" },
      T0,
    );
    // The app is killed here. On next launch:
    expect(await outboxRepository.recoverInterrupted("u1", T0)).toBe(1);
    const item = await outboxRepository.get(clientId);
    expect(item).toMatchObject({
      status: "queued",
      momentId: "m1",
      attempts: 0,
    });
    expect(await outboxRepository.recoverInterrupted("u1", T0)).toBe(0);
  });
});

describe("cleanup", () => {
  it("deleteFiles frees bytes but keeps the item", async () => {
    const { clientId } = await outboxRepository.enqueue(
      base({ files: [file("a.jpg", "image/jpeg", 1)] }),
    );
    await outboxRepository.deleteFiles(clientId);
    expect(await outboxRepository.get(clientId)).toBeDefined();
    await expect(outboxRepository.readFile(clientId, 0)).rejects.toBeInstanceOf(
      OutboxStorageError,
    );
  });

  it("remove deletes the item and its files", async () => {
    const { clientId } = await outboxRepository.enqueue(
      base({ files: [file("a.jpg", "image/jpeg", 1)] }),
    );
    await outboxRepository.remove(clientId);
    expect(await outboxRepository.get(clientId)).toBeUndefined();
    await expect(outboxRepository.readFile(clientId, 0)).rejects.toBeInstanceOf(
      OutboxStorageError,
    );
  });

  it("pruneSynced removes only synced items past retention", async () => {
    const a = await outboxRepository.enqueue(base({ clientId: "a" }));
    const b = await outboxRepository.enqueue(base({ clientId: "b" }));
    for (const id of [a.clientId, b.clientId]) {
      await outboxRepository.apply(id, { type: "start" }, T0);
      await outboxRepository.apply(
        id,
        { type: "momentCreated", momentId: `m-${id}` },
        T0,
      );
      await outboxRepository.apply(
        id,
        { type: "succeeded" },
        id === "a" ? T0 : new Date(T0.getTime() + SYNCED_RETENTION_MS),
      );
    }
    await outboxRepository.enqueue(base({ clientId: "pending" }));
    const later = new Date(T0.getTime() + SYNCED_RETENTION_MS);
    expect(await outboxRepository.pruneSynced("u1", later)).toBe(1);
    const left = (await outboxRepository.list("u1"))
      .map((i) => i.clientId)
      .sort();
    expect(left).toEqual(["b", "pending"]);
  });
});

describe("notifications", () => {
  it("tells subscribers after writes, and stops after unsubscribe", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeOutbox(listener);
    const { clientId } = await outboxRepository.enqueue(base());
    expect(listener).toHaveBeenCalledTimes(1);
    await outboxRepository.apply(clientId, { type: "start" }, T0);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    await outboxRepository.remove(clientId);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
