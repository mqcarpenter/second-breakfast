import type { SyncReport } from "./syncEngine";

/**
 * When to attempt a sync.
 *
 * iOS Safari has no Background Sync API, so nothing can run while the app is
 * closed. Sync is therefore attempted at every moment the app is alive and
 * something might have changed: at launch, when the app returns to the
 * foreground, when the browser reports the network is back, on a timer while
 * visible, and right after a new entry is queued.
 *
 * These are only *when to ask*. The engine probes the server before sending
 * anything, so a trigger firing without a real connection is harmless
 * (`navigator.onLine` is a hint, never a verdict -- docs/features/pwa.md).
 */

export const SYNC_INTERVAL_MS = 30_000;

export type SyncTriggerOptions = {
  getUserId: () => string | null;
  run: (userId: string) => Promise<SyncReport>;
  onReport?: (report: SyncReport) => void;
  intervalMs?: number;
  /** Injected for tests. */
  win?: Pick<Window, "addEventListener" | "removeEventListener">;
  doc?: Pick<
    Document,
    "addEventListener" | "removeEventListener" | "visibilityState"
  >;
};

export type SyncTriggers = {
  /** Ask for a sync now, e.g. right after queueing an entry. */
  requestSync: () => void;
  stop: () => void;
};

export function startSyncTriggers(options: SyncTriggerOptions): SyncTriggers {
  const win = options.win ?? window;
  const doc = options.doc ?? document;
  const intervalMs = options.intervalMs ?? SYNC_INTERVAL_MS;

  const trigger = () => {
    const userId = options.getUserId();
    if (!userId) return;
    // A failed run is retried by the next trigger; it must never surface as an
    // unhandled rejection or take the app down.
    options.run(userId).then(options.onReport, () => undefined);
  };

  const onVisibility = () => {
    if (doc.visibilityState === "visible") trigger();
  };
  const timer = setInterval(() => {
    if (doc.visibilityState === "visible") trigger();
  }, intervalMs);

  win.addEventListener("online", trigger);
  doc.addEventListener("visibilitychange", onVisibility);
  trigger(); // launch

  return {
    requestSync: trigger,
    stop() {
      clearInterval(timer);
      win.removeEventListener("online", trigger);
      doc.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
