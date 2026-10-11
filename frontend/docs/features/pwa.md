# PWA feature contract

Journiv installs as a standalone app on iOS and Android: its own icon, no
browser chrome, a session that survives closing the app, an app shell that
boots without the network, and a controlled update path that never destroys
unsaved writing.

Read [`authentication.md`](authentication.md) first for the session model
(in-memory access token, `HttpOnly` refresh cookie, boot restore) that an
installed app's persistent login depends on.

## Manifest and icons

`vite.config.ts` configures `vite-plugin-pwa`'s `VitePWA({ manifest: {...} })`
and is committed as `manifest.json` (not the plugin's default
`manifest.webmanifest`) -- the backend's `NO_CACHE_FILENAMES`
(`app/frontend.py`) already no-caches that exact filename, so a stale
manifest can never survive a redeploy.

Two icon families exist because Android's maskable mask would crop the
identity mark's deliberately asymmetric tile (`DESIGN.md`, "The identity
mark"):

- **`any`** -- `public/pwa-192x192.png` / `public/pwa-512x512.png`, generated
  from `public/favicon.svg` (the same tile `BrandMark.tsx` renders), via
  `pwa-assets.config.ts`.
- **`maskable`** -- `public/pwa/maskable-icon-192x192.png` /
  `.../512x512.png`, generated from a dedicated full-bleed source,
  `public/pwa/maskable.svg`, via `pwa-assets.maskable.config.ts`. That source
  is `#405DE6` edge-to-edge with the glyph pre-scaled to sit inside the
  central 80% "safe zone" every platform mask respects -- the tile silhouette
  is deliberately absent; the platform's mask supplies the shape.

Regenerate both with `npm run pwa:assets` (it runs both configs in sequence)
whenever the mark's geometry changes, alongside `favicon.ico` and
`apple-touch-icon.png` (`DESIGN.md`). Both preset files set `padding: 0` --
the tool's 0.3 default would re-inset art that is already safe-zone-aware,
shrinking the mark and adding an unwanted border.

Manifest colours (`theme_color`, `background_color`) are literal hex in
`vite.config.ts`, commented with the token they mirror
(`src/styles/tokens.css` `--background`) -- `npm run lint:design` does not
scan that file, so keeping them in sync is manual. The same is true of the
dark `theme-color` `<meta>` in `index.html`; resolve a token's real sRGB hex
with `getComputedStyle` in an actual browser (draw it to a `<canvas>` and read
`getImageData`, since modern browsers echo `oklch(...)` back unresolved from
plain computed style) -- do not eyeball an oklch-to-hex conversion.

**Shortcuts** (Android long-press icon menu; iOS ignores them): New entry
(`/timeline/new`), Timeline (`/timeline`), Insights (`/insights`), each
reusing the `any` 192 icon. Never add a Quick Log shortcut -- it ships behind
`QUICK_LOG_ENABLED = false` (`src/features/shell/shellContext.ts`).

## Service worker and offline shell

`vite-plugin-pwa`'s `generateSW` strategy (`vite.config.ts`) produces
`service-worker.js` at scope `/` -- the exact filename and root scope the
backend already special-cases (`app/frontend.py` `NO_CACHE_FILENAMES` and its
`Service-Worker-Allowed: /` header). `registerType: "prompt"` with
`clientsClaim: false` / `skipWaiting: false` is load-bearing, not stylistic:
either set true and a new worker takes over mid-session, serving new assets to
an old page on the next navigation -- effectively reloading a user out from
under themselves while they are mid-sentence in the editor.

`src/app/pwa/registerServiceWorker.ts` wraps the vanilla
`virtual:pwa-register` (not the React `useRegisterSW` hook) and is called
once from `main.tsx`, after `retireRootFlutterWorker()` resolves and after
first render -- registering earlier would compete with the boot session
restore for the connection and slow down what the user sees first. It is the
single source of truth for update state (`needRefresh` / `offlineReady`); a
future update-bar UI reads `getUpdateState()` / `subscribeToUpdateState()`
rather than mounting the React hook, which would register the worker a
second time.

**No `/api`, `/media`, `/pub`, or any authenticated response ever enters
Cache Storage.** `workbox.runtimeCaching` is deliberately `[]` and
`navigateFallbackDenylist` excludes those prefixes (plus `/legacy/` and
`/flutter_service_worker.js`, so the root worker never answers a Flutter
navigation with the React shell). Offline reading is a separate, bounded
IndexedDB query cache (`src/app/offline/`), not Cache Storage. Verify this
by pathname, not raw URL -- `Request.url` is absolute, so a
`/^\/(api|media|pub)\//` test against it silently never matches.

`/legacy/` keeps its own service worker at `/legacy/flutter_service_worker.js`,
scoped to `/legacy/`. That more specific scope wins control there regardless
of the root worker's registration; the root worker's own fetch handler must
still never claim a `/legacy/` navigation, which is what the denylist entry
guarantees.

## Update UX

`registerType: "prompt"` means a waiting worker never takes over on its own.
`src/app/pwa/usePwaUpdate.ts` exposes `{ updateReady, applyUpdate }`, read by
`UpdateBar` (`src/features/shell/UpdateBar.tsx`) -- persistent chrome in a
reserved bottom row of the shell, not a toast (DESIGN.md: a waiting update is
standing state, not a one-shot outcome). `applyUpdate` is never called without an
explicit click. When the mounted editor has unsaved changes
(`ShellContext.hasUnsavedDraft`, set by `EntryEditorPage.tsx`), clicking
"Restart to update" shows an `AppConfirmDialog` first, warning that unsaved
changes may be lost. `hasUnsavedDraft` reports dirty editor state, not proof
that the latest local-draft write succeeded, so the UI must not promise
restoration from that flag alone. Only confirming calls `applyUpdate`.
Dismissing the bar hides it until the next page load, not forever.

## Install

`src/app/pwa/installPrompt.ts` captures `beforeinstallprompt` at module load
(`preventDefault()`, keep the deferred event) so the event is never missed
before Settings mounts, and clears it on `appinstalled`. `isStandalone()`
checks `display-mode: standalone` and iOS's `navigator.standalone`;
`isIosSafari()` exists because iOS never fires `beforeinstallprompt` at all --
the only install route there is Share → Add to Home Screen.

Settings → **Install & offline** (`src/features/settings/app/AppSettingsPage.tsx`,
after Appearance in `settingsNav.ts`) is the only place install ever appears --
never an unsolicited banner or interstitial (DESIGN.md product character). Its
Install row shows exactly one of: already-installed, the Share instructions
(iOS), an "Install Journiv" button (a captured prompt is available), or an
honest sentence when none applies (an unsupported browser, or plain HTTP) --
never a disabled button with no reason.

**iOS + plain HTTP is the one case that looks like it works but doesn't.**
"Add to Home Screen" needs no service worker, so it succeeds over plain HTTP
-- but nothing was ever precached, so the installed icon has no offline
fallback at all: a real user hit this as a launch-time black screen with no
error, not a graceful degrade. The Share instructions therefore carry an
explicit caveat on an insecure context (`window.isSecureContext === false`)
rather than silently implying full offline support. There is no code fix for
the underlying limitation -- service workers require a secure context, full
stop (`docs/known-gaps.md`) -- only for making sure the person installing
finds out before they rely on it offline.

## Bounded offline read cache

`src/app/offline/` persists a bounded, per-user slice of the TanStack Query
cache to a dedicated IndexedDB database, `journiv-offline` (version 1, one
`queryCache` object store) -- deliberately separate from the `journiv`
database `draftRepository.ts` owns, since that database's version ladder
belongs to drafts. Staged voice notes live in a third database,
`journiv-recordings` (`recordingRepository.ts`), for the same reason: large
binary data with its own lifecycle, and no other module's version ladder to
share. See the Voice notes section of [editor.md](editor.md).

**Allowlist, never denylist** (`persistedQueries.ts`). A query persists only
when its key is one of: `current-user`, `user-settings`, `instance-config`,
`journals`, `tags`, `people`, `moods`, `activities`, `goals`, the *unfiltered*
`["moments", {}]` timeline, and `["moment", id]` for an entry the user
actually opened. Everything else -- `["export", …]`, `["import", …]`,
`["admin", …]`, `["integrations", …]`, `["prompts","library",…]`, any
*filtered* `["moments", {...}]`, and `["moment", id, "media"]` (offline media
viewing is out of scope) -- is excluded by construction. A query must also
have `status: "success"` with data present and be no older than
`MAX_AGE_MS` (7 days). A hand-maintained `CACHE_SCHEMA_VERSION` buster in
`offlineCache.ts` invalidates old shapes on a format change -- never the
build hash, which would wipe the cache on every deploy, precisely when
offline capability matters most. A 120-query cap (`MAX_PERSISTED_QUERIES`)
is enforced by a custom `serialize` in the persister, the only place that
can act across the whole dehydrated client rather than per-query.

**No Cache Storage entry, ever, for `/api`, `/media`, or `/pub`** (Phase 3's
guard). This is the IndexedDB-only alternative for offline *reading*.
Cached `["moment", id]` entries still carry inline signed media URLs baked
into the Delta by the backend (`docs/features/reader.md`) -- there is no
allowlist rule that strips them, so the reader must render its existing
media-placeholder fallback when a persisted URL has expired, keyed by media
id the same way a live re-sign already reloads a slide in place. See
`docs/known-gaps.md` for the follow-up that would remove this residue
entirely (canonicalising stored Deltas the way drafts already do).

**Hydrate before first render, never `PersistQueryClientProvider`.** That
provider restores inside a `useEffect`, so children render before
restoration finishes and an offline launch paints an empty shell that fills
in a frame later -- exactly what this phase exists to avoid. `main.tsx`
instead calls `hydrateOfflineCache` (a 2s-bounded, try/catch'd
`persistQueryClientRestore`) concurrently with the session restore via
`Promise.all`, resolves the boot mode, and only then renders once. A slow or
blocked IndexedDB degrades to an empty cache rather than holding the boot
splash open. Restoration is staged in a temporary `QueryClient`; only a
result that completes before the timeout and still belongs to the active
session/preference lifecycle is committed to the live client. A late IndexedDB
read therefore cannot repopulate data after sign-out, a user switch, or an
offline-reading opt-out.

Persisted queries are stale-while-revalidate once boot restores a live session:
`main.tsx` invalidates only the allowlisted offline snapshot before rendering,
so mounted online screens paint cached data and then fetch the server truth.
This is required even inside the normal query freshness window because the
IndexedDB persister throttles writes; a reload immediately after a mutation can
otherwise restore the pre-mutation snapshot and mistake it for current data.
An offline-restricted boot does not invalidate the snapshot, so cached reading
never depends on the unreachable server. A later session recovery invalidates
the snapshot and refreshes active cached screens in place.

**Boot mode** (`offlineMode.ts`) is derived once from the restore result and
the session hint, then kept current without a reload: `"restored"` → normal;
`"unauthenticated"` → the login route; `"offline"` with a hint → offline-
restricted (the shell renders with cached content); `"offline"` with no hint
→ the login route too, since `LoginPage` already fails closed honestly when
`instanceConfig` can't load offline. The router's `protectedRoute` guard
allows both a live access token and offline-restricted; nothing else. A
later successful `attemptRefresh()` (the original background attempt from
boot, or the retry an `online` event triggers -- `useOnlineStatus.ts`)
upgrades offline-restricted to normal in place; a definite 401/403 or an
explicit sign-out moves to unauthenticated the same way. `navigator.onLine`
never decides any of this by itself -- Journiv is self-hosted and frequently
LAN-reachable while the OS reports no connectivity; it only ever decides
*when* to check, both at boot and while running.

The route guard admits only cached reading destinations while the mode is
offline-restricted: timeline and journal lists plus their Moment readers.
Editor deep links redirect to the corresponding reader; new-entry, Settings,
Import, Library-management, and other mutation-oriented routes redirect to a
cached read route. Normal authenticated routing and unauthenticated login
redirects are unchanged.

In offline-restricted mode, `OfflineBar` (`src/features/shell/`) states
plainly that content is cached, with a relative timestamp from the freshest
query in the cache. The sidebar's "New entry" action is disabled with a
reason rather than left to fail; controls embedded inside otherwise readable
routes still have the narrower gap documented in `docs/known-gaps.md`.

**A fresh sign-in has no hint yet at boot.** `main.tsx` subscribes the
offline cache to whatever `userId` the session hint names *at boot* --
`undefined` for a browser that has never signed in. `sessionStore.adopt()`
(login, signup, OIDC finish) therefore also fires a registered callback
(`registerOfflineCacheSubscribe`) that (re)subscribes with the newly-known
`userId`, or nothing would ever be persisted for a session that started with
a fresh login rather than a cookie-restored one.

**Settings → "Install & offline"** carries the disclosure and controls
(§8.5 of the implementation plan): offline reading ships **on by default** --
an explicit owner decision, disclosure plus an opt-out, not an opt-in
privacy control, and there is no first-run consent prompt. Turning the
switch off purges the cache immediately and stops persisting
(`setOfflineReadingEnabled`). A storage-used estimate reads
`navigator.storage.estimate()`; `navigator.storage.persist()` is requested
once real usage exists, never on a blank first launch. **What this means for
security**: cached entries are protected by the device and browser profile,
not the server session -- someone with the unlocked device can read them in
airplane mode after the server-side session has expired. That is inherent to
any useful offline reading, not a defect, and is written down here rather
than left to be discovered.

## Offline capture and sync

Offline reading (above) never writes. **Capture** is the one write that works
without the server. There is a single **New entry** action
(`useNewEntryTarget`): with a reachable server it opens the full editor; without
one -- the app booted offline-restricted, or the connection dropped mid-session --
it opens the Capture sheet (`src/features/capture/CaptureSheet.tsx`, mounted by
`AppShell` like Quick Log) for text, photos, video, in-app audio and an
optional, explicitly requested location. Capture writes to an on-device
**outbox** and never to the network. Saving closes the sheet with a "Saved on this
device" toast and asks the sync engine to run.

It is a sheet rather than a routed page: it needs no route-guard exception in
offline-restricted mode, and it follows Quick Log's established overlay pattern.

**Outbox** (`src/app/offline/outbox/`). A database of its own, `journiv-outbox`
(version 1: `items` keyed by `clientId`, `media` keyed by `[clientId, index]`),
so no other module's version ladder can wipe queued writing. Bytes are stored as
`ArrayBuffer` (Safari-reliable) in a separate store so listing the queue never
loads photos. `clientId` is the UUID sent as `client_id`. An item moves
`queued -> syncing -> synced | failed` (`stateMachine.ts`, pure and exhaustively
tested). Unlike the read cache, **storage failures here are loud**
(`OutboxStorageError`): the queue holds the only copy of someone's writing.
Enqueue is all-or-nothing in one transaction.

**Idempotency.** `POST /moments` accepts an optional `client_id`, unique per
user (`uq_moment_user_client_id`). A repeated create returns the existing Moment,
including when two requests race (the unique index rejects the loser, which then
returns the winner). Media upload already dedupes per Moment by checksum
(`uq_moment_media_moment_checksum`). Together, repeating any step is harmless.

**Sync** (`syncEngine.ts`). Oldest first, per item: create the Moment, upload
each file, mark synced; progress is recorded after every step, so a sync killed
at any point resumes without loss or duplicates (unit-tested with a kill at five
different steps). The server is probed (`GET /api/v1/health`, 5s) before anything
is sent. Failures are classified: connectivity and auth stop the run and requeue
the item with its attempt refunded; 5xx/429/timeouts back off (5s doubling to
15 minutes, 8 automatic attempts, then the item waits for the user); a rejection
(bad data, unsupported or too-large file) fails that item alone with a plain
reason. A failed upload leaves the Moment, and therefore the text, already on the
server. Media uploads use the XHR helper, which does not refresh an expired token
the way the API client does, so the runtime refreshes once and retries.

**Triggers** (`syncTriggers.ts`, started from `main.tsx`). iOS Safari has no
Background Sync, so nothing runs while the app is closed. Sync is attempted at
launch, on `visibilitychange` to visible, on `online`, every 30 seconds while
visible, and right after a save. `navigator.onLine` only decides *when to ask*;
the probe decides whether the server is really there. A session killed mid-sync
is recovered at the next launch.

**Status UI.** Three surfaces, none of them a toast for standing state:

- Standing chrome in the shell's one top row (`OfflineBar` offline, `OutboxBar`
  online): how many entries are waiting, how many need attention, and a warning
  once anything has waited over 7 days (iOS may evict web-app storage after long
  disuse). **Review** opens `OutboxSheet`.
- **Pending rows** at the top of the unfiltered or single-journal Timeline
  (`PendingEntries`): "Waiting to sync" entries labelled "On this device", or
  "Needs attention" with the reason. They use the Moment row grammar so a capture
  is never invisible after Save. A tag, person or search view shows none, because
  it cannot honestly say whether an unsynced entry belongs there.
- **The confirmation.** When the server accepts a batch, a toast says how many
  entries were saved, the Timeline refreshes, and the pending row is replaced by
  the real Moment carrying a lasting **"Synced from device"** marker
  (`DeviceOrigin`, in the Timeline row and the reader/editor header). The marker
  is driven by `client_id`, which the server returns only for entries created
  through the outbox -- a fact the API returned, never inferred. `OutboxSheet`
  also lists entries confirmed in the last 24 hours with when they were saved.

`OutboxSheet` offers **Retry** for failed entries, **Discard** behind a
confirmation, and **Sync now**.

**Storage.** `navigator.storage.persist()` is requested after the first entry is
saved (never on a blank launch). Before staging, `navigator.storage.estimate()`
refuses a capture that cannot fit and warns past 80% of the quota
(`storage.ts`); an unknown estimate never blocks writing.

**What the entry is.** The typed text becomes the Entry body; photos, video and
audio attach to the Moment, exactly like voice notes and Quick Log media. They
appear in the reader's gallery and can be placed in the body later with "Add to
entry" in the editor. A media-only capture becomes a media-only Moment.

Queued entries are keyed by user and **survive sign-out**: erasing unsynced
writing silently would be data loss. They sync the next time that user is signed
in and the server is reachable.

### Known gaps

- Create-only. Editing an existing entry offline is out of scope (conflict
  handling).
- A clip still being recorded when the app is killed is lost; once Stop is
  pressed it is in the outbox.
- Media is not embedded inline in the body at sync time.
- The picker accepts any `image/*` or `video/*`; the instance's format list is
  not available offline, so an unsupported file fails at sync with a clear reason
  and stays on the device.
- Uploads time out after 60 seconds each; a very large video over a slow link is
  retried with backoff rather than resumed.
- `openapi/openapi.json` gained `client_id` by hand (two schemas) and was
  regenerated, not re-pulled from a Plus-enabled backend. Re-pull when one is
  available.

## Deployment security

The shipped deployment is same-origin: FastAPI serves both the frontend and
API. An explicit cross-origin API is supported only over HTTPS or on a loopback
address because session restore sends the refresh cookie with credentialed
requests. Same-origin LAN HTTP requires the backend's explicit
`ALLOW_INSECURE_COOKIE_AUTH_OVER_HTTP=true` opt-in and does not provide the
installed-app experience because service workers require a secure context
(except on loopback origins).
