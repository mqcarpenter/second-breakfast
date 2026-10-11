import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ mode: "normal", online: true }));
vi.mock("../../app/offline/offlineMode", () => ({
  useBootMode: () => state.mode,
}));
vi.mock("../../app/offline/useOnlineStatus", () => ({
  useOnlineStatus: () => state.online,
}));

import { useNewEntryTarget } from "./useNewEntryTarget";

beforeEach(() => {
  state.mode = "normal";
  state.online = true;
});

describe("useNewEntryTarget", () => {
  it("opens the full editor when the server is reachable", () => {
    expect(renderHook(() => useNewEntryTarget()).result.current).toBe("editor");
  });

  it("opens Capture when the app booted offline-restricted", () => {
    state.mode = "offline-restricted";
    expect(renderHook(() => useNewEntryTarget()).result.current).toBe(
      "capture",
    );
  });

  it("opens Capture when the connection drops mid-session", () => {
    state.online = false;
    expect(renderHook(() => useNewEntryTarget()).result.current).toBe(
      "capture",
    );
  });
});
