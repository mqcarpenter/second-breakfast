import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "../../../api/query/keys";
import { attemptRefresh, sessionStore } from "../../../api/auth/session";
import { api } from "../../../api/client/api";
import { apiBaseUrl } from "../../../api/client/baseUrl";
import {
  MediaUploadError,
  uploadMedia,
} from "../../../features/editor/mediaUpload";
import { toast } from "../../../components/ui/toast";
import { outboxRepository } from "./outboxRepository";
import { createSyncEngine, type SyncDeps, type SyncReport } from "./syncEngine";
import { type SyncTriggers, startSyncTriggers } from "./syncTriggers";

/**
 * Wires the sync engine to the real app: the API client, the XHR media
 * uploader, the session, and the browser's lifecycle events.
 */

const PROBE_TIMEOUT_MS = 5_000;

/** The server answered its health endpoint. A request failure here is the
 *  normal "not at home" case, so it never throws. */
export async function probeServer(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${apiBaseUrl()}/api/v1/health`, {
      cache: "no-store",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** A usable access token, refreshing from the cookie if there is none. */
export async function ensureSession(): Promise<boolean> {
  if (sessionStore.getAccessToken()) return true;
  return (await attemptRefresh()) === "restored";
}

/** The XHR uploader does not refresh an expired token the way the API client
 *  does, so refresh once and retry, or a long-queued photo would fail forever. */
async function uploadWithRefresh(file: File, momentId: string) {
  try {
    return await uploadMedia({ file, momentId }).promise;
  } catch (error) {
    if (!(error instanceof MediaUploadError) || error.kind !== "unauthorized")
      throw error;
    if ((await attemptRefresh()) !== "restored") throw error;
    return uploadMedia({ file, momentId }).promise;
  }
}

export function realSyncDeps(): SyncDeps {
  return {
    probe: probeServer,
    ensureSession,
    createMoment: async (body) => ({ id: (await api.createMoment(body)).id }),
    uploadFile: async (file, momentId) => ({
      id: (await uploadWithRefresh(file, momentId)).id,
    }),
  };
}

/** Refreshes the timeline and confirms to the user when entries reached the server. */
export function announceSync(queryClient: QueryClient, report: SyncReport) {
  if (report.synced === 0) return;
  void queryClient.invalidateQueries({ queryKey: queryKeys.allMoments });
  toast.add({
    title:
      report.synced === 1
        ? "1 entry saved to your journal"
        : `${report.synced} entries saved to your journal`,
    description: "They were written on this device and are now synced.",
  });
}

let active: SyncTriggers | null = null;

/** Starts syncing for the app's lifetime. Call once, after the first render. */
export function startOutboxSync(queryClient: QueryClient): SyncTriggers {
  active?.stop();
  const engine = createSyncEngine(realSyncDeps());
  active = startSyncTriggers({
    getUserId: () => sessionStore.readHint()?.userId ?? null,
    run: async (userId) => {
      await outboxRepository.pruneSynced(userId).catch(() => undefined);
      return engine.sync(userId);
    },
    onReport: (report) => announceSync(queryClient, report),
  });
  return active;
}

/** Ask for a sync now, e.g. right after an entry is queued. */
export function requestOutboxSync() {
  active?.requestSync();
}
