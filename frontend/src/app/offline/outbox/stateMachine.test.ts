import { describe, expect, it } from "vitest";
import {
  applyEvent,
  backoffMs,
  isDue,
  isStale,
  MAX_AUTO_ATTEMPTS,
  OutboxTransitionError,
  STALE_AFTER_MS,
} from "./stateMachine";
import type { OutboxItem } from "./types";

const NOW = new Date("2026-10-11T12:00:00.000Z");

const item = (over: Partial<OutboxItem> = {}): OutboxItem => ({
  clientId: "c1",
  userId: "u1",
  journalId: "j1",
  text: "hello",
  loggedAtUtc: "2026-10-11T11:00:00.000Z",
  timezone: "America/New_York",
  latitude: null,
  longitude: null,
  media: [
    {
      index: 0,
      kind: "image",
      fileName: "a.jpg",
      mimeType: "image/jpeg",
      size: 3,
      uploadedMediaId: null,
    },
    {
      index: 1,
      kind: "audio",
      fileName: "b.m4a",
      mimeType: "audio/mp4",
      size: 3,
      uploadedMediaId: null,
    },
  ],
  status: "queued",
  attempts: 0,
  nextAttemptAt: null,
  lastError: null,
  momentId: null,
  createdAt: "2026-10-11T11:00:00.000Z",
  updatedAt: "2026-10-11T11:00:00.000Z",
  syncedAt: null,
  ...over,
});

describe("backoffMs", () => {
  it("doubles from 5s and caps at 15 minutes", () => {
    expect(backoffMs(0)).toBe(0);
    expect(backoffMs(1)).toBe(5_000);
    expect(backoffMs(2)).toBe(10_000);
    expect(backoffMs(3)).toBe(20_000);
    expect(backoffMs(20)).toBe(15 * 60_000);
  });
});

describe("happy path", () => {
  it("queued -> syncing -> synced, recording progress", () => {
    let s = applyEvent(item(), { type: "start" }, NOW);
    expect(s.status).toBe("syncing");
    expect(s.attempts).toBe(1);
    s = applyEvent(s, { type: "momentCreated", momentId: "m1" }, NOW);
    s = applyEvent(s, { type: "mediaUploaded", index: 0, mediaId: "x" }, NOW);
    s = applyEvent(s, { type: "mediaUploaded", index: 1, mediaId: "y" }, NOW);
    s = applyEvent(s, { type: "succeeded" }, NOW);
    expect(s.status).toBe("synced");
    expect(s.syncedAt).toBe(NOW.toISOString());
    expect(s.lastError).toBeNull();
  });

  it("cannot succeed before the moment exists or while media is missing", () => {
    const syncing = applyEvent(item(), { type: "start" }, NOW);
    expect(() => applyEvent(syncing, { type: "succeeded" }, NOW)).toThrow(
      OutboxTransitionError,
    );
    const created = applyEvent(
      syncing,
      { type: "momentCreated", momentId: "m1" },
      NOW,
    );
    expect(() => applyEvent(created, { type: "succeeded" }, NOW)).toThrow(
      OutboxTransitionError,
    );
  });

  it("an entry with no media can succeed once the moment exists", () => {
    let s = applyEvent(item({ media: [] }), { type: "start" }, NOW);
    s = applyEvent(s, { type: "momentCreated", momentId: "m1" }, NOW);
    expect(applyEvent(s, { type: "succeeded" }, NOW).status).toBe("synced");
  });
});

describe("failure handling", () => {
  it("a retryable failure requeues with backoff and keeps progress", () => {
    let s = applyEvent(item(), { type: "start" }, NOW);
    s = applyEvent(s, { type: "momentCreated", momentId: "m1" }, NOW);
    s = applyEvent(s, { type: "retryableFailure", error: "network" }, NOW);
    expect(s.status).toBe("queued");
    expect(s.momentId).toBe("m1");
    expect(s.lastError).toBe("network");
    expect(s.nextAttemptAt).toBe(new Date(NOW.getTime() + 5_000).toISOString());
    expect(isDue(s, NOW)).toBe(false);
    expect(isDue(s, new Date(NOW.getTime() + 5_000))).toBe(true);
  });

  it("stops retrying by itself after the attempt budget", () => {
    const s = applyEvent(
      item({ status: "syncing", attempts: MAX_AUTO_ATTEMPTS }),
      { type: "retryableFailure", error: "network" },
      NOW,
    );
    expect(s.status).toBe("failed");
    expect(s.nextAttemptAt).toBeNull();
  });

  it("a permanent failure fails immediately", () => {
    const s = applyEvent(
      item({ status: "syncing", attempts: 1 }),
      { type: "permanentFailure", error: "rejected" },
      NOW,
    );
    expect(s.status).toBe("failed");
    expect(s.lastError).toBe("rejected");
  });

  it("manual retry resets attempts and keeps recorded progress", () => {
    const failed = item({
      status: "failed",
      attempts: 8,
      lastError: "x",
      momentId: "m1",
    });
    const s = applyEvent(failed, { type: "retry" }, NOW);
    expect(s).toMatchObject({
      status: "queued",
      attempts: 0,
      lastError: null,
      momentId: "m1",
    });
  });
});

describe("interruption", () => {
  it("returns to queued, due immediately, without losing progress", () => {
    const s = applyEvent(
      item({ status: "syncing", attempts: 2, momentId: "m1" }),
      { type: "interrupted" },
      NOW,
    );
    expect(s.status).toBe("queued");
    expect(s.attempts).toBe(2);
    expect(s.momentId).toBe("m1");
    expect(isDue(s, NOW)).toBe(true);
  });
});

describe("illegal transitions", () => {
  it.each([
    [{ type: "start" } as const, "syncing"],
    [{ type: "start" } as const, "synced"],
    [{ type: "start" } as const, "failed"],
    [{ type: "retry" } as const, "queued"],
    [{ type: "retry" } as const, "synced"],
    [{ type: "interrupted" } as const, "queued"],
    [{ type: "succeeded" } as const, "queued"],
    [{ type: "momentCreated", momentId: "m" } as const, "queued"],
  ])("rejects %j from %s", (event, status) => {
    expect(() =>
      applyEvent(item({ status: status as OutboxItem["status"] }), event, NOW),
    ).toThrow(OutboxTransitionError);
  });

  it("rejects an upload for media that does not exist", () => {
    expect(() =>
      applyEvent(
        item({ status: "syncing" }),
        { type: "mediaUploaded", index: 9, mediaId: "z" },
        NOW,
      ),
    ).toThrow(OutboxTransitionError);
  });
});

describe("isDue and isStale", () => {
  it("only queued items are due", () => {
    expect(isDue(item(), NOW)).toBe(true);
    for (const status of ["syncing", "synced", "failed"] as const)
      expect(isDue(item({ status }), NOW)).toBe(false);
  });

  it("warns at seven days for anything not yet synced", () => {
    const old = new Date(NOW.getTime() - STALE_AFTER_MS).toISOString();
    expect(isStale(item({ createdAt: old }), NOW)).toBe(true);
    expect(isStale(item({ createdAt: old, status: "failed" }), NOW)).toBe(true);
    expect(isStale(item({ createdAt: old, status: "synced" }), NOW)).toBe(
      false,
    );
    expect(isStale(item(), NOW)).toBe(false);
  });
});
