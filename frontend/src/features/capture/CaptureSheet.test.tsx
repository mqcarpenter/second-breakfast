import "fake-indexeddb/auto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeOutboxDb,
  OutboxStorageError,
  outboxRepository,
} from "../../app/offline/outbox/outboxRepository";

vi.mock("../../api/auth/session", () => ({
  sessionStore: {
    readHint: () => ({ userId: "u1" }),
    getAccessToken: () => "t",
  },
}));
vi.mock("../../api/client/api", () => ({
  api: {
    journals: vi.fn(async () => [
      {
        id: "j-a",
        title: "Daily",
        is_archived: false,
        is_favorite: false,
        sort_order: 0,
        created_at: "2026-01-02T00:00:00Z",
      },
      {
        id: "j-b",
        title: "Travel",
        is_archived: false,
        is_favorite: false,
        sort_order: 1,
        created_at: "2026-01-01T00:00:00Z",
      },
    ]),
  },
}));
const requestOutboxSync = vi.fn();
vi.mock("../../app/offline/outbox/syncRuntime", () => ({
  requestOutboxSync: () => requestOutboxSync(),
}));
const checkQuota = vi.fn();
vi.mock("../../app/offline/outbox/storage", () => ({
  checkQuota: (n: number) => checkQuota(n),
  requestPersistence: vi.fn(async () => true),
}));

import { api } from "../../api/client/api";
import { CaptureSheet } from "./CaptureSheet";

function setup() {
  const onOpenChange = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  render(<CaptureSheet open onOpenChange={onOpenChange} />, { wrapper });
  return { onOpenChange };
}

const save = () => screen.getByRole("button", { name: "Save entry" });

async function ready() {
  await screen.findByRole("option", { name: "Daily" });
}

beforeEach(() => {
  vi.clearAllMocks();
  checkQuota.mockResolvedValue({ level: "ok", freeBytes: null });
  window.localStorage.clear();
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

describe("CaptureSheet", () => {
  it("cannot save an empty capture", async () => {
    setup();
    await ready();
    expect(save().hasAttribute("disabled")).toBe(true);
  });

  it("saves text to the on-device outbox, closes, and asks for a sync", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = setup();
    await ready();
    await user.selectOptions(screen.getByLabelText("Journal"), "j-b");
    await user.type(screen.getByLabelText("Entry"), "Hello from the road");
    await user.click(save());

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    const [item] = await outboxRepository.list("u1");
    expect(item).toMatchObject({
      journalId: "j-b",
      text: "Hello from the road",
      status: "queued",
    });
    expect(item?.clientId).toMatch(/[0-9a-f-]{36}/);
    expect(requestOutboxSync).toHaveBeenCalledTimes(1);
    // The choice is remembered for the next capture.
    expect(window.localStorage.getItem("journiv:capture:journal")).toBe("j-b");
  });

  it("stages attached files with the entry, and removing one drops it", async () => {
    const user = userEvent.setup();
    setup();
    await ready();
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    await user.upload(input, [
      new File([new Uint8Array([1, 2])], "a.jpg", { type: "image/jpeg" }),
      new File([new Uint8Array([3])], "b.mov", { type: "video/quicktime" }),
    ]);
    expect(await screen.findByRole("img", { name: "a.jpg" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Remove b.mov" }));
    await user.click(save());

    await waitFor(async () =>
      expect((await outboxRepository.list("u1")).length).toBe(1),
    );
    const [item] = await outboxRepository.list("u1");
    expect(item?.media.map((m) => m.fileName)).toEqual(["a.jpg"]);
    expect(item?.text).toBe("");
  });

  it("saves a typed place with the entry and remembers it for next time", async () => {
    const user = userEvent.setup();
    setup();
    await ready();
    await user.type(screen.getByLabelText("Entry"), "morning coffee");
    await user.type(
      screen.getByLabelText("Or name a place"),
      "The Corner Cafe",
    );
    await user.click(screen.getByRole("button", { name: "Use this name" }));
    await user.click(save());

    await waitFor(async () =>
      expect((await outboxRepository.list("u1")).length).toBe(1),
    );
    const [item] = await outboxRepository.list("u1");
    expect(item?.place).toEqual({ name: "The Corner Cafe" });
    expect(item?.latitude).toBeNull();
    const remembered = JSON.parse(
      window.localStorage.getItem("journiv:capture:places") ?? "[]",
    );
    expect(remembered[0].place.name).toBe("The Corner Cafe");
  });

  it("explains when no journals are cached yet", async () => {
    vi.mocked(api.journals).mockResolvedValueOnce([]);
    setup();
    expect(
      await screen.findByText(/aren.t available on this device yet/i),
    ).toBeTruthy();
  });

  it("refuses, keeping everything, when the device is out of space", async () => {
    checkQuota.mockResolvedValue({ level: "full", freeBytes: 0 });
    const user = userEvent.setup();
    const { onOpenChange } = setup();
    await ready();
    await user.type(screen.getByLabelText("Entry"), "keep me");
    await user.click(save());

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /free space/i,
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(await outboxRepository.list("u1")).toEqual([]);
    expect((screen.getByLabelText("Entry") as HTMLTextAreaElement).value).toBe(
      "keep me",
    );
  });

  it("keeps the writing and says so when storage fails", async () => {
    vi.spyOn(outboxRepository, "enqueue").mockRejectedValueOnce(
      new OutboxStorageError("Could not save this entry on the device"),
    );
    const user = userEvent.setup();
    const { onOpenChange } = setup();
    await ready();
    await user.type(screen.getByLabelText("Entry"), "precious");
    await user.click(save());

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /still here/i,
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect((screen.getByLabelText("Entry") as HTMLTextAreaElement).value).toBe(
      "precious",
    );
  });

  it("asks before discarding anything that was typed", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = setup();
    await ready();
    await user.type(screen.getByLabelText("Entry"), "draft");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Discard this capture?")).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(await outboxRepository.list("u1")).toEqual([]);
  });

  it("closes without a prompt when nothing was entered", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = setup();
    await ready();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
