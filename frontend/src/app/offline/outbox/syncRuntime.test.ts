import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const attemptRefresh = vi.fn();
const getAccessToken = vi.fn();
vi.mock("../../../api/auth/session", () => ({
  attemptRefresh: () => attemptRefresh(),
  sessionStore: {
    getAccessToken: () => getAccessToken(),
    readHint: () => null,
  },
}));
vi.mock("../../../api/client/baseUrl", () => ({ apiBaseUrl: () => "" }));

const { probeServer, ensureSession } = await import("./syncRuntime");

beforeEach(() => {
  attemptRefresh.mockReset();
  getAccessToken.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("probeServer", () => {
  it("is true when the health endpoint answers ok, bypassing caches", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    expect(await probeServer()).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/health",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("is false for a server error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    expect(await probeServer()).toBe(false);
  });

  it("is false, not a throw, when the network is gone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );
    expect(await probeServer()).toBe(false);
  });

  it("gives up after the timeout instead of hanging", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url: string, init: RequestInit) =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener("abort", () =>
                reject(new DOMException("aborted", "AbortError")),
              );
            }),
        ),
      );
      const pending = probeServer();
      await vi.advanceTimersByTimeAsync(5_001);
      expect(await pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ensureSession", () => {
  it("is true with a token and does not refresh", async () => {
    getAccessToken.mockReturnValue("token");
    expect(await ensureSession()).toBe(true);
    expect(attemptRefresh).not.toHaveBeenCalled();
  });

  it("refreshes when there is no token, and trusts only a restored session", async () => {
    getAccessToken.mockReturnValue(null);
    attemptRefresh.mockResolvedValueOnce("restored");
    expect(await ensureSession()).toBe(true);
    for (const result of ["offline", "unauthenticated", "superseded"]) {
      attemptRefresh.mockResolvedValueOnce(result);
      expect(await ensureSession()).toBe(false);
    }
  });
});
