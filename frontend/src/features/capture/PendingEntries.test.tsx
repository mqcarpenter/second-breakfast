import "fake-indexeddb/auto";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
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

import { ShellContext, type ShellContextValue } from "../shell/shellContext";
import { PendingEntries } from "./PendingEntries";

const queue = (clientId: string, journalId: string, text: string) =>
  outboxRepository.enqueue({
    clientId,
    userId: "u1",
    journalId,
    text,
    loggedAt: new Date("2026-10-11T12:00:00Z"),
    timezone: "UTC",
    files: [],
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

const shell = (openOutbox = vi.fn()): ShellContextValue => ({
  openNavigation: () => {},
  openQuickLog: () => {},
  openCapture: () => {},
  openOutbox,
  hasUnsavedDraft: false,
  setHasUnsavedDraft: () => {},
});

describe("PendingEntries", () => {
  it("renders nothing when nothing is pending", () => {
    const { container } = render(<PendingEntries />);
    expect(container.innerHTML).toBe("");
  });

  it("lists entries not yet confirmed, labelled as on the device", async () => {
    await queue("a", "j1", "written on the train");
    render(<PendingEntries />);
    expect(await screen.findByText("written on the train")).toBeTruthy();
    expect(screen.getByText("On this device")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Waiting to sync" }),
    ).toBeTruthy();
  });

  it("limits the list to one journal when scoped", async () => {
    await queue("a", "j1", "in journal one");
    await queue("b", "j2", "in journal two");
    render(<PendingEntries journalId="j2" />);
    expect(await screen.findByText("in journal two")).toBeTruthy();
    expect(screen.queryByText("in journal one")).toBeNull();
  });

  it("flags a failed entry and says why", async () => {
    await queue("a", "j1", "stuck");
    await outboxRepository.apply("a", { type: "start" });
    await outboxRepository.apply("a", {
      type: "permanentFailure",
      error: "The server rejected this entry (400).",
    });
    render(<PendingEntries />);
    expect(await screen.findByText("Needs attention")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("rejected");
  });

  it("opens the review sheet when a row is tapped", async () => {
    await queue("a", "j1", "tap me");
    const openOutbox = vi.fn();
    const user = userEvent.setup();
    render(
      <ShellContext.Provider value={shell(openOutbox)}>
        <PendingEntries />
      </ShellContext.Provider>,
    );
    await user.click(await screen.findByRole("button", { name: /tap me/ }));
    expect(openOutbox).toHaveBeenCalledTimes(1);
  });
});
