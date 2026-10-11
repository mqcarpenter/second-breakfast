import { afterEach, describe, expect, it, vi } from "vitest";
import { checkQuota, requestPersistence } from "./storage";

function stubStorage(storage: Partial<StorageManager> | undefined) {
  vi.stubGlobal("navigator", { storage });
}
afterEach(() => vi.unstubAllGlobals());

describe("checkQuota", () => {
  const estimate = (usage: number, quota: number) => ({
    estimate: async () => ({ usage, quota }),
  });

  it("is ok with plenty of room", async () => {
    stubStorage(estimate(100, 1000));
    expect(await checkQuota(100)).toEqual({ level: "ok", freeBytes: 900 });
  });

  it("warns when staging would pass 80% of the quota", async () => {
    stubStorage(estimate(700, 1000));
    expect((await checkQuota(150)).level).toBe("near");
  });

  it("refuses when it would not fit at all", async () => {
    stubStorage(estimate(900, 1000));
    expect((await checkQuota(200)).level).toBe("full");
  });

  it("never blocks writing when the browser cannot say", async () => {
    stubStorage(undefined);
    expect(await checkQuota(1e12)).toEqual({ level: "ok", freeBytes: null });
    stubStorage({ estimate: async () => ({}) });
    expect((await checkQuota(1e12)).level).toBe("ok");
    stubStorage({
      estimate: async () => {
        throw new Error("denied");
      },
    });
    expect((await checkQuota(1)).level).toBe("ok");
  });
});

describe("requestPersistence", () => {
  it("asks once and reports the answer", async () => {
    const persist = vi.fn().mockResolvedValue(true);
    stubStorage({ persist, persisted: async () => false });
    expect(await requestPersistence()).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("does not ask again when already persistent", async () => {
    const persist = vi.fn();
    stubStorage({ persist, persisted: async () => true });
    expect(await requestPersistence()).toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });

  it("is false when unsupported or refused, never a throw", async () => {
    stubStorage(undefined);
    expect(await requestPersistence()).toBe(false);
    stubStorage({
      persist: async () => {
        throw new Error("x");
      },
    });
    expect(await requestPersistence()).toBe(false);
  });
});
