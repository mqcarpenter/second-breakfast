import type { OutboxPlace } from "../../app/offline/outbox/types";

/**
 * Places used in earlier captures, remembered on this device so a repeat spot is
 * one tap -- including offline, when search is unavailable. A per-viewer
 * convenience in localStorage: it never leaves the device, and the app works
 * the same without it (storage can be blocked or empty).
 */

const KEY = "journiv:capture:places";
export const MAX_RECENT_PLACES = 8;

export type CapturePlace = {
  place: OutboxPlace;
  latitude: number | null;
  longitude: number | null;
};

function sameplace(a: CapturePlace, b: CapturePlace): boolean {
  return (
    a.place.name.trim().toLowerCase() === b.place.name.trim().toLowerCase() &&
    a.latitude === b.latitude &&
    a.longitude === b.longitude
  );
}

export function readRecentPlaces(): CapturePlace[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is CapturePlace =>
          Boolean(entry) &&
          typeof entry === "object" &&
          typeof (entry as CapturePlace).place?.name === "string" &&
          (entry as CapturePlace).place.name.trim().length > 0,
      )
      .slice(0, MAX_RECENT_PLACES);
  } catch {
    return [];
  }
}

/** Most recent first, deduplicated, capped. */
export function rememberPlace(entry: CapturePlace) {
  try {
    const rest = readRecentPlaces().filter((p) => !sameplace(p, entry));
    window.localStorage.setItem(
      KEY,
      JSON.stringify([entry, ...rest].slice(0, MAX_RECENT_PLACES)),
    );
  } catch {
    // Storage blocked or full: remembering places is optional.
  }
}

export function forgetPlaces() {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing to forget.
  }
}
