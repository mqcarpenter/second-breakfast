/**
 * Device storage guards for the outbox (docs/features/pwa.md).
 *
 * Queued photos and video live in IndexedDB. iOS may evict a web app's storage
 * after long disuse unless it is marked persistent, and a full quota makes
 * writes fail -- so ask for persistence once real data exists, and check there
 * is room before staging a large file rather than failing midway.
 */

/** Warn when staging this would take usage past this fraction of the quota. */
export const NEAR_QUOTA_FRACTION = 0.8;

export type QuotaLevel = "ok" | "near" | "full";

export type QuotaCheck = {
  level: QuotaLevel;
  /** Bytes still available, or null when the browser cannot say. */
  freeBytes: number | null;
};

/** Asks the browser not to evict this origin's storage. Best effort; false when
 *  unsupported or refused. Call after the first entry is saved, never on a
 *  blank first launch (a refusal there teaches the browser nothing useful). */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.persist)
      return false;
    if (navigator.storage.persisted && (await navigator.storage.persisted()))
      return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/** Whether `incomingBytes` more would fit. Unknown estimates are treated as ok:
 *  a wrong "full" would refuse someone's writing for no reason, while a real
 *  full quota surfaces as a loud storage error when the write is attempted. */
export async function checkQuota(incomingBytes: number): Promise<QuotaCheck> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.estimate)
      return { level: "ok", freeBytes: null };
    const { usage, quota } = await navigator.storage.estimate();
    if (!quota || usage === undefined) return { level: "ok", freeBytes: null };
    const free = Math.max(0, quota - usage);
    const after = usage + incomingBytes;
    if (after > quota) return { level: "full", freeBytes: free };
    if (after > quota * NEAR_QUOTA_FRACTION)
      return { level: "near", freeBytes: free };
    return { level: "ok", freeBytes: free };
  } catch {
    return { level: "ok", freeBytes: null };
  }
}
