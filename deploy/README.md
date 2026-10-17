# Deploy: Compose (LAN only)

Journiv, Postgres and Valkey as an isolated Compose project (`second-breakfast`). No host ports are published.

Caddy (TLS and the reverse proxy) and Ollama live in a separate, shared **platform** stack that fronts every
app on this host. That stack creates the external `edge` network that `sb-app` joins, so it must be running
before this one starts. The journal's site block (`sites/journal.caddy`, proxying to `sb-app:8000`) lives there.

## First run (on the server)

1. Clone the repo, `cd deploy`.
2. `umask 077; cp env.example .env`, then edit the host name and paths.
3. Generate secrets without printing them:
   `umask 077; { echo "SECRET_KEY=$(openssl rand -base64 32)"; echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"; } >> .env`
   Remove the empty `SECRET_KEY=` and `POSTGRES_PASSWORD=` lines from the example first.
4. Make sure the platform stack is up: `docker network inspect edge >/dev/null && echo ok`.
5. Give the Journiv containers (uid 1000) write access before the first start, otherwise they crash-loop with
   `mkdir: cannot create directory '/data/logs': Permission denied`:
   `mkdir -p data/logs && sudo chown 1000:1000 data && sudo chown -R 1000:1000 data/logs`
   Do the same for `MEDIA_DIR` and `IMPORTS_DIR` if they are elsewhere. Leave `data/postgres` alone.
6. `docker compose up -d --build`

### Media on an NTFS drive

NTFS mounted with the `acl` option stores real ownership, so folders created with `sudo mkdir` belong to root and
uid 1000 cannot write to them. After creating the media and imports folders, run
`sudo chown -R 1000:1000 <media-folder>` and verify with
`sudo -u '#1000' touch <media-folder>/.write-test`. Keep Postgres on local disk, never on this drive.

## Name resolution (mDNS)

`.local` names resolve through Avahi, with no DNS server. Install `avahi-utils`, copy
`avahi/mdns-alias.service.example` to `/etc/systemd/system/mdns-alias.service`, fill in the name
and the server's LAN IP, then `sudo systemctl enable --now mdns-alias`. The host may also need a
static or reserved LAN IP.

## Trusting the certificate (once per device)

Caddy signs with its own private CA. The CA belongs to the platform stack, so one trusted root covers every app.
Download `http://<name>.local/root.crt`, then on iPhone:
Settings > Profile Downloaded > Install, then Settings > General > About > Certificate Trust Settings > **turn the toggle on**.
Installing the profile alone is not enough: until the toggle is on, HTTPS just spins in Safari.
If the name does not resolve at home, turn off Private Relay and Limit IP Address Tracking for that Wi-Fi network.

## After the first account is created

Set `DISABLE_SIGNUP=true` in `.env` and run `docker compose up -d`.

## Checks

- `curl -kI https://<name>.local` returns 200 through the platform Caddy.
- `curl -s https://<name>.local/api/v1/health`
- Port 8000 is not reachable from the LAN.
