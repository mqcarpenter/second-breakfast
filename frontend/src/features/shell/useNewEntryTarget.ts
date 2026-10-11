import { useBootMode } from "../../app/offline/offlineMode";
import { useOnlineStatus } from "../../app/offline/useOnlineStatus";

/**
 * Where the one "New entry" action goes (docs/features/pwa.md).
 *
 * With a reachable server it opens the full editor. Without one it opens
 * Capture, which saves on the device and syncs later. The boot mode is the
 * verdict about the server (it comes from real requests, never from
 * `navigator.onLine` alone); `navigator.onLine` only adds the case of a
 * connection that dropped mid-session, where choosing Capture is always safe.
 */
export function useNewEntryTarget(): "editor" | "capture" {
  const offlineRestricted = useBootMode() === "offline-restricted";
  const online = useOnlineStatus();
  return offlineRestricted || !online ? "capture" : "editor";
}
