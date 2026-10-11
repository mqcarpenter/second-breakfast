import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncReport } from "./syncEngine";
import { SYNC_INTERVAL_MS, startSyncTriggers } from "./syncTriggers";

const REPORT: SyncReport = {
  outcome: "idle",
  synced: 0,
  failed: 0,
  remaining: 0,
};

function fakeEnv(visibility: "visible" | "hidden" = "visible") {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: visibility });
  return {
    win: win as unknown as Window,
    doc: doc as unknown as Document,
    setVisibility(v: "visible" | "hidden") {
      doc.visibilityState = v;
      doc.dispatchEvent(new Event("visibilitychange"));
    },
    online: () => win.dispatchEvent(new Event("online")),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("startSyncTriggers", () => {
  it("syncs at launch", () => {
    const run = vi.fn().mockResolvedValue(REPORT);
    const env = fakeEnv();
    const t = startSyncTriggers({
      getUserId: () => "u1",
      run,
      win: env.win,
      doc: env.doc,
    });
    expect(run).toHaveBeenCalledWith("u1");
    t.stop();
  });

  it("syncs when the app returns to the foreground, not when it is hidden", () => {
    const run = vi.fn().mockResolvedValue(REPORT);
    const env = fakeEnv();
    const t = startSyncTriggers({
      getUserId: () => "u1",
      run,
      win: env.win,
      doc: env.doc,
    });
    run.mockClear();
    env.setVisibility("hidden");
    expect(run).not.toHaveBeenCalled();
    env.setVisibility("visible");
    expect(run).toHaveBeenCalledTimes(1);
    t.stop();
  });

  it("syncs when the browser reports the network is back", () => {
    const run = vi.fn().mockResolvedValue(REPORT);
    const env = fakeEnv();
    const t = startSyncTriggers({
      getUserId: () => "u1",
      run,
      win: env.win,
      doc: env.doc,
    });
    run.mockClear();
    env.online();
    expect(run).toHaveBeenCalledTimes(1);
    t.stop();
  });

  it("syncs on a timer while visible only", () => {
    const run = vi.fn().mockResolvedValue(REPORT);
    const env = fakeEnv();
    const t = startSyncTriggers({
      getUserId: () => "u1",
      run,
      win: env.win,
      doc: env.doc,
    });
    run.mockClear();
    vi.advanceTimersByTime(SYNC_INTERVAL_MS);
    expect(run).toHaveBeenCalledTimes(1);
    env.setVisibility("hidden");
    run.mockClear();
    vi.advanceTimersByTime(SYNC_INTERVAL_MS * 3);
    expect(run).not.toHaveBeenCalled();
    t.stop();
  });

  it("does nothing without a signed-in user", () => {
    const run = vi.fn().mockResolvedValue(REPORT);
    const env = fakeEnv();
    const t = startSyncTriggers({
      getUserId: () => null,
      run,
      win: env.win,
      doc: env.doc,
    });
    env.online();
    t.requestSync();
    expect(run).not.toHaveBeenCalled();
    t.stop();
  });

  it("reports results, and survives a failed run", async () => {
    const onReport = vi.fn();
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(REPORT);
    const env = fakeEnv();
    const t = startSyncTriggers({
      getUserId: () => "u1",
      run,
      onReport,
      win: env.win,
      doc: env.doc,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(onReport).not.toHaveBeenCalled();
    t.requestSync();
    await vi.advanceTimersByTimeAsync(0);
    expect(onReport).toHaveBeenCalledWith(REPORT);
    t.stop();
  });

  it("stop() removes every listener and the timer", () => {
    const run = vi.fn().mockResolvedValue(REPORT);
    const env = fakeEnv();
    const t = startSyncTriggers({
      getUserId: () => "u1",
      run,
      win: env.win,
      doc: env.doc,
    });
    t.stop();
    run.mockClear();
    env.online();
    env.setVisibility("visible");
    vi.advanceTimersByTime(SYNC_INTERVAL_MS * 2);
    expect(run).not.toHaveBeenCalled();
  });
});
