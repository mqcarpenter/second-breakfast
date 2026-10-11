# CLAUDE.md: second-breakfast (Journiv-based personal journal)

This file is the project brief for Claude Code. It lives at the root of `mqcarpenter/second-breakfast`, a standalone repo seeded from Journiv's history. It isn't a GitHub fork. Upstream's `frontend/CLAUDE.md` and `frontend/AGENTS.md` still govern frontend work. Read them before touching `frontend/`.

Private values (domain, server IP, SSH alias, paths) live in `CLAUDE.local.md`, which is gitignored. Never move them into this file. This repo is public. It can be switched to private later because it isn't in Journiv's fork network. Until then, treat it as public.

---

## 1. Mission

Replace Day One with a self-hosted journal built on Journiv (`journiv/journiv-app`), maintained in `mqcarpenter/second-breakfast` and deployed with Docker Compose on the owner's home server over SSH.

Done means:

1. All Day One content is imported: text, formatting, photos, videos, audio, location, weather, tags, dates, timezones, stars, and six journals.
2. The UI uses the owner's colors, fonts, name, logo, and icons.
3. The iPhone home-screen PWA creates entries offline and syncs them when it can reach the server on home Wi-Fi, with no loss and no duplicates.
4. A map of entries and plain-English search through a local LLM (Ollama) work, and no journal data leaves the LAN.
5. TLS is valid on the LAN, nothing is exposed to the internet, and backups run.

## 2. Hard rules: secrets and private data

This repo is public. Treat every commit as published the moment it's pushed. A pushed secret is compromised even if the commit is later deleted.

### Never commit

- `.env`, `.env.*` (except `env.template`), `*.local.*`, `CLAUDE.local.md`, `.claude/settings.local.json`
- Secrets of any kind: `SECRET_KEY`, `POSTGRES_PASSWORD`, DNS API tokens, OIDC secrets, Immich keys, SSH keys, TLS keys (`*.pem`, `*.key`, `*.crt`), Caddy data or config volumes
- Journal content: Day One exports (`*.zip`), extracted JSON, media, database files and dumps, backups, import temp folders, logs
- Infrastructure details: real domain or subdomains, LAN IPs, server hostnames, SSH aliases, usernames, absolute home paths, router details. Use placeholders such as `journal.home.example.com`, `192.0.2.10` and `<server>`.
- Screenshots or test fixtures built from real journal entries. Write synthetic fixtures. Real-data checks run outside the repo and are never committed.

### Required guardrails (set up in workstream A before any other commit)

1. Append the block below to `.gitignore`. Upstream already ignores `.env`, `data/`, `*.db` and `backups/`.

   ```gitignore
   # --- mqcarpenter fork: private data guardrails ---
   .env.*
   !env.template
   *.local.*
   CLAUDE.local.md
   .claude/settings.local.json
   secrets/
   deploy/.env
   deploy/caddy/data/
   deploy/caddy/config/
   *.pem
   *.key
   *.crt
   *.p12
   *.zip
   imports/
   media/
   exports/
   *.sql
   *.dump
   *.sql.gz
   ```

2. Add gitleaks to the existing `.pre-commit-config.yaml`. Pin `rev` to the latest gitleaks release tag.

   ```yaml
     - repo: https://github.com/gitleaks/gitleaks
       rev: vX.Y.Z  # pin to latest release
       hooks:
         - id: gitleaks
   ```

3. Commit `.claude/settings.json` with deny rules so Claude Code can't read secret files:

   ```json
   {
     "permissions": {
       "deny": [
         "Read(./.env)",
         "Read(./.env.*)",
         "Read(./**/.env)",
         "Read(./deploy/.env)",
         "Read(./secrets/**)",
         "Read(./CLAUDE.local.md)"
       ]
     }
   }
   ```

   `CLAUDE.local.md` is still loaded as project memory. The deny rule only blocks ad hoc reads.

### Every commit and push

- Stage files by name. Never run `git add -A`, `git add .` or `git commit -a`.
- Before committing, run `git diff --cached --name-only` and `git diff --cached`, then confirm no item from the never-commit list is present.
- Run `pre-commit run --all-files` and `gitleaks git --staged` (or rely on the hook). Don't bypass with `--no-verify`.
- Before pushing, run `gitleaks git` on the branch history.
- If a secret reaches a commit, stop. Don't push. Tell the owner. If it was already pushed, tell the owner to rotate the secret immediately. Rewriting history doesn't make a pushed secret safe.

### Handling secrets on the server

- Generate secrets on the server, for example `openssl rand -base64 32` written straight into `deploy/.env` with `umask 077`. Never print secret values to the terminal or the transcript, and never echo them back after writing.
- Check that a key exists with `grep -c '^SECRET_KEY=' deploy/.env`, not by printing it.
- Keep the DNS API token only in the server's `deploy/.env`, scoped to DNS edit on a single zone.

## 3. Repo and branches

- `origin` is `git@github.com:mqcarpenter/second-breakfast.git` (public, standalone, not a GitHub fork). `upstream` is `https://github.com/journiv/journiv-app.git`.
- `main` is upstream history at a release tag, plus merged fork work. Base fork work on upstream release tags.
- Seeding (workstream A) replaces the placeholder README commit `bbf1ab8` ("Initial commit", README only) with Journiv's history, so upstream rebases stay clean. Don't merge with `--allow-unrelated-histories`.
- Use one branch per workstream: `fork/guardrails`, `feat/dayone-audio`, `deploy/compose-caddy`, `theme/brand`, `feat/offline-capture`, `feat/addon-map-search`.
- Keep diffs narrow, because every upstream release gets rebased onto them. Prefer new files and token overrides over edits to upstream components.
- Syncing upstream: `git fetch upstream --tags`, rebase each fork branch onto the new tag, run the full test suites, then redeploy.
- License: PolyForm Noncommercial 1.0.0. Keep `LICENSE.md` and all notices. Personal, noncommercial use only. Never modify or redistribute `web/`, the proprietary legacy Flutter client. All UI work happens in `frontend/`.
- Plus features (`app/plus/*.so`) aren't in the public repo. Build with `REQUIRE_PLUS_FEATURES=false`.

## 4. Environments

| Role | Where | Notes |
|---|---|---|
| Dev | The owner's Mac, fork clone | Claude Code runs here. Python via `uv`, frontend via `npm`. |
| Server | `<server>` over SSH (alias in `CLAUDE.local.md`) | Docker + Compose. Deploy dir with `deploy/.env` (never in git). |
| Phone | iPhone, Safari home-screen PWA | Only reaches the server on home Wi-Fi. |
| Legacy | A legacy local checkout on the Mac (path in `CLAUDE.local.md`) | Earlier Mac-only setup. Holds `journiv/overlay/dayone-audio.patch` and the Day One export zip. Read-only reference. |

Test commands, from the repo root:

- Backend unit and CLI: `uv sync --locked && uv run pytest tests/unit tests/cli -q --no-cov -n auto`
- Frontend: `cd frontend && npm ci && npm test` and `npm run build`
- Integration tests need a running stack. See `tests/integration`.

Use `--no-cov` for targeted runs, because the repo enforces 60% global coverage.

## 5. Architecture

```
iPhone PWA (Safari) ──HTTPS, LAN only──▶ Caddy (TLS, DNS-01 wildcard)
                                            │
                                            ▼
                          Journiv app (FastAPI + React build, fork image)
                          celery-worker / celery-beat
                          Postgres 18 (local disk) · Valkey
                                            │ read-only DB role
                                            ▼
                          addon: map + search API (Ollama + pgvector)
                          Ollama (local)
Media: /data/media on server storage (bind mount). DB never on SMB/NFS.
```

## 6. TLS and DNS (public domain, LAN-only service)

A public domain is the right choice. Use the ACME DNS-01 challenge. Let's Encrypt never connects to the server, so nothing gets exposed.

- **Certificate:** wildcard `*.home.<domain>`, issued by Caddy through DNS-01. A wildcard keeps service names out of Certificate Transparency logs. Individual names like `journal.<domain>` would be published there.
- **Caddy build:** stock Caddy lacks DNS provider modules. Build a custom image:

  ```Dockerfile
  FROM caddy:2-builder AS builder
  RUN xcaddy build --with github.com/caddy-dns/<provider>
  FROM caddy:2
  COPY --from=builder /usr/bin/caddy /usr/bin/caddy
  ```

  Pick `<provider>` from github.com/caddy-dns to match the domain's DNS host. If the host has no API module, either move DNS to a supported provider or delegate `_acme-challenge` with a CNAME to an acme-dns instance.
- **Name resolution:** don't publish a public A record pointing at a private IP. It leaks LAN layout, and many routers block it as DNS rebinding. Resolve `journal.home.<domain>` to the server's LAN IP with local DNS only: a router static DNS entry, or a Pi-hole/AdGuard Home/dnsmasq container on the server, set as the Wi-Fi network's DNS.
- **Side effect:** off home Wi-Fi the name doesn't resolve, so the PWA sees "server unreachable" and queues. That's the intended offline trigger.
- **iPhone caveat:** if the name doesn't resolve at home, turn off Private Relay or "Limit IP Address Tracking" for the home Wi-Fi network.
- **Journiv config:** `DOMAIN_NAME=journal.home.<domain>`, `DOMAIN_SCHEME=https`, and leave `ALLOW_INSECURE_COOKIE_AUTH_OVER_HTTP=false`. Caddy reverse-proxies to `app:8000` on the compose network. Don't publish port 8000 on the host.

## 7. Workstreams

Do them in order unless the owner says otherwise. Each one ends with its acceptance criteria met and a summary of what changed.

### A. Seed the repo and add guardrails (`fork/guardrails`)

- Seed `second-breakfast` from Journiv. This needs one force push to `main`, so get the owner's explicit go-ahead first. Only the README commit is lost.

  ```sh
  git clone git@github.com:mqcarpenter/second-breakfast.git && cd second-breakfast
  git remote add upstream https://github.com/journiv/journiv-app.git
  git fetch upstream --tags
  git checkout -B main v0.1.0-beta.26
  git push --force-with-lease=main:bbf1ab8 origin main
  git push origin --tags
  ```

- Upstream already has a `README.md`. Fork notes go in `FORK.md`. Add the `.gitignore` block, the gitleaks hook and `.claude/settings.json` from §2. Add this file.
- **Done when:** `pre-commit run --all-files` passes, `gitleaks git` is clean, and `git check-ignore -v .env deploy/.env CLAUDE.local.md some.zip` matches every path.

### B. Day One audio import (`feat/dayone-audio`)

- Apply `<legacy-checkout>/journiv/overlay/dayone-audio.patch` with `git am`. It targets `v0.1.0-beta.26` (`c5ea6b1`). Rebase if `main` has moved.
- It covers 7 files: `app/data_transfer/dayone/{models,dayone_parser,mappers,richtext_parser}.py`, `app/services/import_service.py`, `app/utils/import_export/zip_handler.py` and `app/utils/quill_delta.py`. Tests are in `tests/unit/data_transfer/test_dayone_audio_import.py` (16 tests).
- The patch adds a `DayOneAudio` model, extracts `audios/`, maps recordings to `audio` media, adds `{"audio": id}` delta embeds, handles typed `dayone-moment:/audio/<id>` links, and sniffs headers to rename MP3 streams that Day One saved as `.m4a` (a handful of files in the owner's export).
- **Done when:** the unit and CLI suites pass (756 at beta.26).

### C. Deploy: Compose + Caddy (`deploy/compose-caddy`)

- Add `deploy/docker-compose.yml`, derived from upstream's Postgres compose. Build the Journiv image from the fork (`build: ..`, `REQUIRE_PLUS_FEATURES=false`). Add the custom Caddy service, `deploy/Caddyfile`, `deploy/env.example` with placeholders only, and `deploy/README.md`.
- On the server: clone the fork, create `deploy/.env` from the example, generate secrets there (§2), then run `docker compose up -d --build`.
- Postgres and Valkey data go on local disk. Media goes to the path set in `CLAUDE.local.md`.
- After the owner creates his account, set `DISABLE_SIGNUP=true`.
- **Done when:** `https://journal.home.<domain>` loads on the iPhone over home Wi-Fi with a valid certificate, `curl -I` from the server shows 200 through Caddy, port 8000 isn't reachable from the LAN, and the health endpoint passes.

### D. Theme (`theme/brand`)

- Scope is colors, fonts, app name, logo, and PWA icons. No layout or component redesign.
- Override semantic tokens in `frontend/src/styles/tokens.css` (`:root` and `.dark`) or in a new fork-only token file imported after it. Follow `frontend/DESIGN.md`: semantic roles only, and keep its measured-contrast rule (WCAG AA) in both modes.
- Fonts: replace the `@fontsource-variable/*` packages and font-family tokens.
- Name and logo: `BrandMark.tsx`, `index.html`, the PWA manifest in `vite.config.ts`, and icons generated from `pwa-assets.config.ts` into `frontend/public/`.
- the owner supplies the palette, fonts, name, and logo files. Don't invent them.
- **Done when:** `npm test` and `npm run build` pass, both modes have been checked for contrast, and the installed PWA shows the new name and icon.

### E. Offline capture + sync (`feat/offline-capture`)

Current state: the PWA shell, an offline read cache (`frontend/src/app/offline/`, IndexedDB `journiv-offline`) and editor drafts (`draftRepository.ts`) exist. In offline-restricted mode, routes redirect away from the editor. There's no write queue.

Build:

1. **Backend idempotency.** Add an optional client-generated `client_id` (UUID) to `MomentCreate`, unique per user, with an Alembic migration. A repeated create with the same `client_id` returns the existing moment with 200 instead of creating a duplicate. Media upload already dedupes by checksum per moment. Verify that and add tests.
2. **Outbox.** Add a new IndexedDB store (its own DB or a versioned addition, never breaking `journiv-offline` or the drafts DB). Each item holds `client_id`, journal id, delta, `logged_at_utc`, timezone, location if granted, media blobs (photo, video, audio) and status: `queued`, `syncing`, `synced` or `failed` with an error.
3. **Capture UI.** Offline-restricted mode allows a capture route: a new entry with text, photos and audio. It writes to the outbox only. Don't enable editing of existing entries offline. That's out of scope because it brings conflict handling.
4. **Sync.** iOS Safari has no Background Sync API. Trigger sync on app launch, on `visibilitychange` to visible, on the `online` event, and on a timer while visible. Probe the server's health endpoint first. Sync in FIFO order: create the moment (with `client_id`), then upload media, then mark synced. Resume a partial sync safely. Retry with backoff.
5. **Status UI.** Show the queue count in the shell. List queued and failed items with retry. Warn when items are older than 7 days, because iOS may evict web-app storage after long disuse.
6. **Storage.** Call `navigator.storage.persist()` on install. Check `navigator.storage.estimate()` before storing large video and warn near quota.

**Done when:** these pass on the iPhone. (a) In airplane mode, create 3 entries with photo and audio, return to Wi-Fi, open the app, and all 3 appear on the server exactly once. (b) Kill the app mid-sync, reopen, and get no duplicates and no losses. (c) Vitest covers the outbox state machine and the backend idempotency.

### F. Day One import

- Copy the zip to server storage (the owner runs the copy, see §8). Run a dry run, then the import, through the admin CLI:

  ```sh
  docker compose --profile admin up -d admin-cli
  docker compose exec admin-cli journiv-admin import-data /imports/<zip> -u <email> -s dayone --dry-run
  docker compose exec admin-cli journiv-admin import-data /imports/<zip> -u <email> -s dayone
  ```

- Disk: extraction plus media copy peak at about 3× the zip, about three times the zip size. Check free space first.
- Expected counts are in `CLAUDE.local.md`. PDFs are skipped, because Journiv has no document media type.
- **Done when:** the counts match, and a spot check of entries with photo, video, audio and location renders correctly.

### G. Map + search add-on (`feat/addon-map-search`)

- A separate service in `addon/`. Don't modify Journiv internals.
- It connects to Postgres as a read-only role. Embeddings use pgvector and Ollama, with incremental re-indexing.
- Endpoints: `/map` (entries with coordinates, linking back to Journiv) and `/ask` (natural-language query with retrieval over entries, answers citing entry links).
- It runs behind Caddy on the same wildcard. All inference stays local.
- Size the models to server RAM and CPU. the owner supplies the specs.

### H. Backups

- Nightly `pg_dump` plus a media rsync to a second disk or the NAS. Keep 7 daily and 4 weekly copies. Test a restore.
- Backups never go into the repo.

## 8. Steps the owner runs locally

Claude Code can't do these. Ask for them when the workstream needs them, then wait.

| When | Step | Command or action |
|---|---|---|
| A | Approve the seed force push | Say yes when Claude asks to replace the README-only commit on `main`. |
| A | Turn on GitHub secret protection | second-breakfast → Settings → Code security: enable Secret scanning and Push protection. |
| A | Branch protection (after seeding) | Settings → Branches: protect `main` from force pushes and deletion. |
| Any | Optional: go private | Settings → General → Danger Zone → Change visibility. |
| A | Install hook tools on the Mac | `brew install gitleaks pre-commit` then, in the repo, `pre-commit install` |
| C | SSH alias | Add a `Host <alias>` entry in `~/.ssh/config` with key auth. Confirm `ssh <alias> docker version` works without a password prompt. |
| C | DNS API token | At the DNS provider, create a token scoped to DNS edit on the domain's zone only. Put it in the server's `deploy/.env` yourself, or let Claude write it there without echoing it. |
| C | Local DNS | Add the router or Pi-hole entry `journal.home.<domain>` → server LAN IP. |
| C | First login | Open the URL on the iPhone, create the account, then tell Claude so signups get disabled. |
| C | Install the PWA | Safari → Share → Add to Home Screen. |
| D | Brand assets | Provide the palette (hex or oklch), font names, app name, and logo SVG. |
| E | Device test | Airplane-mode test on the iPhone, as described in E's acceptance criteria. |
| F | Copy the export | `rsync -avP <local-export-path>/<zip> <alias>:<imports-path>/` |
| G | Server specs | `ssh <alias> 'nproc; free -h; df -h'`, then share the output. |

## 9. CLAUDE.local.md template (gitignored)

Create this at the root of the second-breakfast clone on the Mac and fill it in. Never commit it.

```markdown
# Private project values. Do not commit.
- Domain: <domain>            # e.g. example.com
- Journal host: journal.home.<domain>
- DNS provider: <provider>    # caddy-dns module name
- Server SSH alias: <alias>
- Server LAN IP: <ip>
- Server deploy dir: <path>
- Media path on server: <path>
- Imports path on server: <path>
- Journiv account email: <email>
```

## 10. Reference facts

- Upstream baseline is `v0.1.0-beta.26` (`c5ea6b1`), from Sep 27, 2026. Stack: FastAPI, SQLModel, Alembic, Celery, Valkey, Postgres 18, and a React frontend built with Vite, TanStack Query/Router, Tailwind, shadcn base-vega and Quill.
- Media storage dirs are `images/`, `videos/` and `audio/` under `/data/media/<user_id>/`. Per-user dedup is by checksum.
- `MediaType` values are `image`, `video`, `audio` and `unknown`. The frontend has `WaveformPlayer` for audio.
- Media is served with its Content-Type taken from the file extension (`media_service._resolve_servable_path_and_content_type`).
- Day One export sizes, file counts and journal names are in `CLAUDE.local.md`.
