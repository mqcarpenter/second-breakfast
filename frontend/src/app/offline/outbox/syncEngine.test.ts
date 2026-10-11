import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../../../api/client/errors";
import type { MomentCreate } from "../../../api/generated/types.gen";
import { MediaUploadError } from "../../../features/editor/mediaUpload";
import {
  blobToArrayBuffer,
  closeOutboxDb,
  outboxRepository,
} from "./outboxRepository";
import {
  buildMomentBody,
  classifyFailure,
  createSyncEngine,
  describeFailure,
  type SyncDeps,
} from "./syncEngine";
import type { OutboxItem } from "./types";

const T0 = new Date("2026-10-11T12:00:00.000Z");
const never = () => new Promise<never>(() => undefined);

const file = (name: string, ...bytes: number[]) =>
  new File([new Uint8Array(bytes)], name, { type: "image/jpeg" });

/** An in-memory server with the two idempotency guarantees the real one has. */
function fakeServer() {
  const moments = new Map<string, { id: string; media: Map<string, string> }>();
  let nextId = 1;
  return {
    moments,
    mediaCount: () =>
      [...moments.values()].reduce((n, m) => n + m.media.size, 0),
    createMoment: async (body: MomentCreate) => {
      const key = body.client_id as string;
      let moment = moments.get(key);
      if (!moment) {
        moment = { id: `moment-${nextId++}`, media: new Map() };
        moments.set(key, moment);
      }
      return { id: moment.id };
    },
    uploadFile: async (f: File, momentId: string) => {
      const bytes = new Uint8Array(await blobToArrayBuffer(f));
      const checksum = `${f.name}:${bytes.join(",")}`;
      const moment = [...moments.values()].find((m) => m.id === momentId);
      if (!moment) throw new Error("no such moment");
      let id = moment.media.get(checksum);
      if (!id) {
        id = `media-${nextId++}`;
        moment.media.set(checksum, id);
      }
      return { id };
    },
  };
}

function deps(
  server: ReturnType<typeof fakeServer>,
  over: Partial<SyncDeps> = {},
): SyncDeps {
  return {
    probe: async () => true,
    ensureSession: async () => true,
    createMoment: server.createMoment,
    uploadFile: server.uploadFile,
    now: () => T0,
    ...over,
  };
}

const enqueue = (clientId: string, files: File[] = [], text = "hello") =>
  outboxRepository.enqueue({
    clientId,
    userId: "u1",
    journalId: "j1",
    text,
    loggedAt: T0,
    timezone: "UTC",
    files,
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

describe("happy path", () => {
  it("creates the moment once, uploads every file, and frees the bytes", async () => {
    const server = fakeServer();
    await enqueue("a", [file("1.jpg", 1), file("2.jpg", 2)]);
    const report = await createSyncEngine(deps(server)).sync("u1");

    expect(report).toEqual({
      outcome: "done",
      synced: 1,
      failed: 0,
      remaining: 0,
    });
    expect(server.moments.size).toBe(1);
    expect(server.mediaCount()).toBe(2);
    expect((await outboxRepository.get("a"))?.status).toBe("synced");
    await expect(outboxRepository.readFile("a", 0)).rejects.toThrow();
  });

  it("does nothing, and never probes, when the queue is empty", async () => {
    const server = fakeServer();
    let probes = 0;
    const report = await createSyncEngine(
      deps(server, {
        probe: async () => {
          probes += 1;
          return true;
        },
      }),
    ).sync("u1");
    expect(report.outcome).toBe("idle");
    expect(probes).toBe(0);
  });

  it("syncs oldest first", async () => {
    const order: string[] = [];
    const server = fakeServer();
    for (const id of ["first", "second", "third"]) {
      await enqueue(id);
      await new Promise((r) => setTimeout(r, 3)); // distinct createdAt
    }
    await createSyncEngine(
      deps(server, {
        createMoment: async (body) => {
          order.push(body.client_id as string);
          return server.createMoment(body);
        },
      }),
    ).sync("u1");
    expect(order).toEqual(["first", "second", "third"]);
  });
});

describe("no connection or no session", () => {
  it("leaves everything queued when the server is unreachable", async () => {
    const server = fakeServer();
    await enqueue("a", [file("1.jpg", 1)]);
    const report = await createSyncEngine(
      deps(server, { probe: async () => false }),
    ).sync("u1");
    expect(report).toMatchObject({
      outcome: "offline",
      synced: 0,
      remaining: 1,
    });
    expect(server.moments.size).toBe(0);
    expect(await outboxRepository.get("a")).toMatchObject({
      status: "queued",
      attempts: 0,
    });
  });

  it("leaves everything queued when signed out", async () => {
    const server = fakeServer();
    await enqueue("a");
    const report = await createSyncEngine(
      deps(server, { ensureSession: async () => false }),
    ).sync("u1");
    expect(report.outcome).toBe("signed-out");
    expect(server.moments.size).toBe(0);
  });

  it("losing the connection mid-run stops cleanly with no penalty", async () => {
    const server = fakeServer();
    await enqueue("a", [file("1.jpg", 1)]);
    await enqueue("b");
    const report = await createSyncEngine(
      deps(server, {
        uploadFile: async () => {
          throw new MediaUploadError("network", "x");
        },
      }),
    ).sync("u1");
    expect(report.outcome).toBe("offline");
    expect(report.synced).toBe(0);
    // The moment exists on the server, recorded locally, attempt refunded, and
    // the second item was never touched.
    expect(await outboxRepository.get("a")).toMatchObject({
      status: "queued",
      attempts: 0,
      momentId: "moment-1",
    });
    expect(await outboxRepository.get("b")).toMatchObject({
      status: "queued",
      attempts: 0,
    });
  });
});

describe("killed at any step", () => {
  // The process dies at step N: that call never returns and nothing after it
  // runs. A fresh engine on the next launch must finish with no loss and no
  // duplicates -- the acceptance criterion for offline capture.
  const steps = [
    "creating the moment",
    "after the moment, before the first upload",
    "during the first upload",
    "after the first upload reached the server but before it was recorded",
    "during the second upload",
  ];

  it.each(steps.map((s, i) => [s, i] as const))(
    "recovers when killed %s",
    async (_name, step) => {
      const server = fakeServer();
      await enqueue("a", [file("1.jpg", 1), file("2.jpg", 2)]);

      let call = 0;
      const dying = deps(server, {
        createMoment: async (body) => {
          if (step === 0) return never();
          const result = await server.createMoment(body);
          if (step === 1) return never();
          return result;
        },
        uploadFile: async (f, momentId) => {
          call += 1;
          if (step === 2 && call === 1) return never();
          const result = await server.uploadFile(f, momentId);
          if (step === 3 && call === 1) return never(); // reached the server, never recorded
          if (step === 4 && call === 2) return never();
          return result;
        },
      });
      // Start the sync and abandon it, exactly as a killed app would.
      void createSyncEngine(dying).sync("u1");
      await new Promise((r) => setTimeout(r, 50));
      expect((await outboxRepository.get("a"))?.status).toBe("syncing");

      // Next launch.
      const report = await createSyncEngine(deps(server)).sync("u1");

      expect(report).toMatchObject({
        outcome: "done",
        synced: 1,
        remaining: 0,
      });
      expect(server.moments.size).toBe(1); // no duplicate moment
      expect(server.mediaCount()).toBe(2); // each file exactly once
      expect((await outboxRepository.get("a"))?.status).toBe("synced");
    },
  );
});

describe("failures", () => {
  it("backs off a retryable failure and succeeds when due again", async () => {
    const server = fakeServer();
    await enqueue("a");
    let failures = 1;
    let clock = T0;
    const engine = createSyncEngine(
      deps(server, {
        now: () => clock,
        createMoment: async (body) => {
          if (failures-- > 0) throw new ApiError("boom", { status: 503 });
          return server.createMoment(body);
        },
      }),
    );

    const first = await engine.sync("u1");
    expect(first).toMatchObject({ synced: 0, failed: 0, remaining: 1 });
    expect(await outboxRepository.get("a")).toMatchObject({
      status: "queued",
      attempts: 1,
    });

    // Not due yet: nothing happens.
    expect((await engine.sync("u1")).outcome).toBe("idle");

    clock = new Date(T0.getTime() + 6_000);
    expect(await engine.sync("u1")).toMatchObject({ synced: 1, remaining: 0 });
  });

  it("a rejected entry fails alone and does not block the rest", async () => {
    const server = fakeServer();
    await enqueue("bad");
    await new Promise((r) => setTimeout(r, 3));
    await enqueue("good");
    const report = await createSyncEngine(
      deps(server, {
        createMoment: async (body) => {
          if (body.client_id === "bad")
            throw new ApiError("no", { status: 400 });
          return server.createMoment(body);
        },
      }),
    ).sync("u1");
    expect(report).toMatchObject({
      outcome: "done",
      synced: 1,
      failed: 1,
      remaining: 1,
    });
    const bad = await outboxRepository.get("bad");
    expect(bad?.status).toBe("failed");
    expect(bad?.lastError).toMatch(/rejected/i);
  });

  it("an unsupported file fails the item, names the file, and keeps the moment", async () => {
    const server = fakeServer();
    await enqueue("a", [file("weird.xyz", 1)]);
    const report = await createSyncEngine(
      deps(server, {
        uploadFile: async () => {
          throw new MediaUploadError("unsupported-type", "x");
        },
      }),
    ).sync("u1");
    expect(report.failed).toBe(1);
    const item = await outboxRepository.get("a");
    expect(item?.lastError).toContain("weird.xyz");
    expect(item?.momentId).toBe("moment-1"); // the writing is on the server
    expect(await outboxRepository.readFile("a", 0)).toBeDefined(); // the bytes are kept
  });

  it("a manual retry after a failure can finish the job", async () => {
    const server = fakeServer();
    await enqueue("a");
    let reject = true;
    const engine = createSyncEngine(
      deps(server, {
        createMoment: async (body) => {
          if (reject) throw new ApiError("no", { status: 422 });
          return server.createMoment(body);
        },
      }),
    );
    await engine.sync("u1");
    expect((await outboxRepository.get("a"))?.status).toBe("failed");
    reject = false;
    await outboxRepository.apply("a", { type: "retry" }, T0);
    expect(await engine.sync("u1")).toMatchObject({ synced: 1, remaining: 0 });
  });
});

describe("single flight", () => {
  it("shares one run between concurrent callers", async () => {
    const server = fakeServer();
    await enqueue("a");
    let creates = 0;
    const engine = createSyncEngine(
      deps(server, {
        createMoment: async (body) => {
          creates += 1;
          return server.createMoment(body);
        },
      }),
    );
    const [one, two] = await Promise.all([
      engine.sync("u1"),
      engine.sync("u1"),
    ]);
    expect(one).toBe(two);
    expect(creates).toBe(1);
  });
});

describe("classifyFailure", () => {
  it.each([
    [new TypeError("Failed to fetch"), "connectivity"],
    [new ApiError("x"), "connectivity"],
    [new ApiError("x", { status: 401 }), "auth"],
    [new ApiError("x", { status: 403 }), "auth"],
    [new ApiError("x", { status: 429 }), "retryable"],
    [new ApiError("x", { status: 503 }), "retryable"],
    [new ApiError("x", { status: 400 }), "permanent"],
    [new ApiError("x", { status: 404 }), "permanent"],
    [new MediaUploadError("network", "x"), "connectivity"],
    [new MediaUploadError("unauthorized", "x"), "auth"],
    [new MediaUploadError("server", "x"), "retryable"],
    [new MediaUploadError("too-large", "x"), "permanent"],
    [new Error("???"), "retryable"],
  ])("%s -> %s", (error, expected) => {
    expect(classifyFailure(error)).toBe(expected);
  });

  it("never shows the server's own text", () => {
    expect(
      describeFailure(new ApiError("SELECT * FROM secrets", { status: 400 })),
    ).not.toContain("SELECT");
  });
});

describe("buildMomentBody", () => {
  const item = (over: Partial<OutboxItem>): OutboxItem => ({
    clientId: "c",
    userId: "u",
    journalId: "j",
    text: "  hi there  ",
    loggedAtUtc: "2026-10-11T12:00:00.000Z",
    timezone: "America/New_York",
    latitude: null,
    longitude: null,
    media: [],
    status: "queued",
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    momentId: null,
    createdAt: "",
    updatedAt: "",
    syncedAt: null,
    ...over,
  });

  it("sends the idempotency key, time, zone and a terminated delta", () => {
    expect(buildMomentBody(item({}))).toEqual({
      client_id: "c",
      logged_at_utc: "2026-10-11T12:00:00.000Z",
      logged_timezone: "America/New_York",
      entry: {
        journal_id: "j",
        content_delta: { ops: [{ insert: "hi there\n" }] },
      },
    });
  });

  it("makes a media-only capture a media-only moment", () => {
    expect(buildMomentBody(item({ text: "   " })).entry).toBeUndefined();
  });

  it("includes location only when both coordinates are present", () => {
    expect(buildMomentBody(item({ latitude: 1, longitude: 2 }))).toMatchObject({
      latitude: 1,
      longitude: 2,
    });
    expect(buildMomentBody(item({ latitude: 1 }))).not.toHaveProperty(
      "latitude",
    );
  });
});
