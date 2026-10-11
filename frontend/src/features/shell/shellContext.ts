import { createContext, useContext } from "react";

/** Build-time release gate. Keep the implementation checked in while hiding
 *  every user-facing Quick Log entry point; flip to true when it is ready. */
export const QUICK_LOG_ENABLED = false;

export type ShellContextValue = {
  /** Opens the compact navigation drawer. */
  openNavigation: () => void;
  /** Opens the Quick Log capture sheet (docs/features/quicklog.md). */
  openQuickLog: () => void;
  /** Opens the offline-capable capture sheet (docs/features/pwa.md). */
  openCapture: () => void;
  /** Opens the list of entries waiting to sync (docs/features/pwa.md). */
  openOutbox: () => void;
  /** Whether the mounted editor has unsaved changes. useLocalDraft already
   *  flushes a safety-net copy on pagehide, so this only gates the PWA
   *  update bar's confirmation (docs/features/pwa.md) -- it is not a save
   *  guarantee by itself. */
  hasUnsavedDraft: boolean;
  setHasUnsavedDraft: (value: boolean) => void;
};

export const ShellContext = createContext<ShellContextValue>({
  openNavigation: () => {},
  openQuickLog: () => {},
  openCapture: () => {},
  openOutbox: () => {},
  hasUnsavedDraft: false,
  setHasUnsavedDraft: () => {},
});

/** Panes and the sidebar read this for shell-level affordances (the compact
 *  navigation trigger in a PageBar, the Quick Log entry points). */
export function useShell() {
  return useContext(ShellContext);
}
