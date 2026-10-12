# second-breakfast

A personal, noncommercial fork of [Journiv](https://github.com/journiv/journiv-app), self-hosted on a home server and used to replace Day One.

Upstream baseline: `v0.1.0-beta.26`. Fork work is rebased onto each upstream release tag.

Project brief and workstreams: see `CLAUDE.md`. Journiv's own README is `README.md`.

Licensed under PolyForm Noncommercial 1.0.0 (see `LICENSE.md`). Personal use only.

Theme: Tron (1982), in `frontend/src/styles/tron.css` -- a token-value layer over
`tokens.css`, so upstream token changes still merge cleanly.

Product name and icon: the app is branded **Trapper Keeper**. The icon master is
`frontend/brand/trapper-keeper-icon.png`; every raster icon is generated from it
with `npm run pwa:assets`. Internal identifiers (CSS `jv-` classes, storage keys,
database names, the `X-Journiv-Client` header) deliberately keep their upstream
names so upstream merges stay clean.

