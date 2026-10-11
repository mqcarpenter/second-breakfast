import "fake-indexeddb/auto";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeOutboxDb,
  outboxRepository,
} from "../../app/offline/outbox/outboxRepository";

vi.mock("../../api/auth/session", () => ({
  sessionStore: {
    readHint: () => ({ userId: "u1" }),
    getAccessToken: () => "t",
  },
}));
const requestOutboxSync = vi.fn();
vi.mock("../../app/offline/outbox/syncRuntime", () => ({
  requestOutboxSync: () => requestOutboxSync(),
}));

import { ShellContext, type ShellContextValue } from "../shell/shellContext";
import { OutboxBar } from "./OutboxBar";
import { OutboxNotice } from "./OutboxNotice";
import { useOutbox } from "./useOutbox";
import { OutboxSheet } from "./OutboxSheet";

const T0 = new Date("2026-10-11T12:00:00.000Z");

const queue = (clientId: string, text = "an entry", at = T0) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
  try {
    return outboxRepository.enqueue({
      clientId,
      userId: "u1",
      journalId: "j",
      text,
      loggedAt: at,
      timezone: "UTC",
      files: [],
    });
  } finally {
    vi.useRealTimers();
  }
};

const fail = async (clientId: string, error: string) => {
  await outboxRepository.apply(clientId, { type: "start" });
  await outboxRepository.apply(clientId, { type: "permanentFailure", error });
};

beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
  await closeOutboxDb();
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase("journiv-outbox");
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
});

describe("OutboxSheet", () => {
  it("says so when nothing is waiting", async () => {
    render(<OutboxSheet open onOpenChange={vi.fn()} />);
    expect(await screen.findByText("Everything is synced")).toBeTruthy();
  });

  it("lists waiting entries and shows why a failed one failed", async () => {
    await queue("a", "first thought");
    await queue("b", "second thought");
    await fail("b", "The server rejected this entry (400).");
    render(<OutboxSheet open onOpenChange={vi.fn()} />);

    expect(await screen.findByText("first thought")).toBeTruthy();
    expect(screen.getByText(/ago · Waiting to sync/)).toBeTruthy();
    expect(screen.getByText(/ago · Needs attention/)).toBeTruthy();
    expect(
      screen.getByText("The server rejected this entry (400)."),
    ).toBeTruthy();
  });

  it("retries a failed entry and asks for a sync", async () => {
    await queue("b");
    await fail("b", "boom");
    const user = userEvent.setup();
    render(<OutboxSheet open onOpenChange={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Retry" }));

    await waitFor(async () =>
      expect((await outboxRepository.get("b"))?.status).toBe("queued"),
    );
    expect(requestOutboxSync).toHaveBeenCalledTimes(1);
  });

  it("discards only after confirming", async () => {
    await queue("a");
    const user = userEvent.setup();
    render(<OutboxSheet open onOpenChange={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Discard" }));
    expect(await screen.findByText("Discard this entry?")).toBeTruthy();
    expect(await outboxRepository.get("a")).toBeDefined();

    const buttons = screen.getAllByRole("button", { name: "Discard" });
    await user.click(buttons[buttons.length - 1] as HTMLElement);
    await waitFor(async () =>
      expect(await outboxRepository.get("a")).toBeUndefined(),
    );
  });

  it("Sync now asks the engine to run", async () => {
    await queue("a");
    const user = userEvent.setup();
    render(<OutboxSheet open onOpenChange={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: /Sync now/ }));
    expect(requestOutboxSync).toHaveBeenCalledTimes(1);
  });
});

function NoticeHost() {
  return <OutboxNotice queue={useOutbox()} />;
}

describe("OutboxNotice and OutboxBar", () => {
  const shell = (openOutbox = vi.fn()): ShellContextValue => ({
    openNavigation: () => {},
    openQuickLog: () => {},
    openCapture: () => {},
    openOutbox,
    hasUnsavedDraft: false,
    setHasUnsavedDraft: () => {},
  });

  it("renders nothing when the queue is empty", () => {
    const { container } = render(<OutboxBar />);
    expect(container.innerHTML).toBe("");
  });

  it("counts waiting and failed entries and opens the review sheet", async () => {
    await queue("a");
    await queue("b");
    await queue("c");
    await fail("c", "x");
    const openOutbox = vi.fn();
    const user = userEvent.setup();
    render(
      <ShellContext.Provider value={shell(openOutbox)}>
        <OutboxBar />
      </ShellContext.Provider>,
    );
    expect((await screen.findByRole("status")).textContent).toContain(
      "2 entries waiting to sync.",
    );
    expect(screen.getByRole("status").textContent).toContain(
      "1 entry needs attention.",
    );
    await user.click(screen.getByRole("button", { name: "Review" }));
    expect(openOutbox).toHaveBeenCalledTimes(1);
  });

  it("warns once anything has waited over seven days", async () => {
    await queue("old", "ancient", new Date(Date.now() - 8 * 24 * 60 * 60_000));
    render(
      <ShellContext.Provider value={shell()}>
        <NoticeHost />
      </ShellContext.Provider>,
    );
    expect(await screen.findByText(/over 7 days/)).toBeTruthy();
  });

  it("does not warn for recent entries", async () => {
    await queue("fresh", "new", new Date());
    render(
      <ShellContext.Provider value={shell()}>
        <NoticeHost />
      </ShellContext.Provider>,
    );
    await screen.findByText(/1 entry waiting/);
    expect(screen.queryByText(/over 7 days/)).toBeNull();
  });
});
