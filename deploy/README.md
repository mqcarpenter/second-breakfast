# Deploy: Compose + Caddy (LAN only)

Journiv, Postgres, Valkey and Caddy as an isolated Compose project (`second-breakfast`).
Only Caddy publishes host ports (443, and 80 for the CA root download). Journiv's port 8000 is not published.

## First run (on the server)

1. Clone the repo, `cd deploy`.
2. `umask 077; cp env.example .env`, then edit the host name and paths.
3. Generate secrets without printing them:
   `umask 077; { echo "SECRET_KEY=$(openssl rand -base64 32)"; echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"; } >> .env`
   Remove the empty `SECRET_KEY=` and `POSTGRES_PASSWORD=` lines from the example first.
4. Check ports 80 and 443 are free: `sudo ss -ltnp | grep -E ':(80|443)\b'`.
5. `docker compose up -d --build`

## Name resolution (mDNS)

`.local` names resolve through Avahi, with no DNS server. Install `avahi-utils`, copy
`avahi/mdns-alias.service.example` to `/etc/systemd/system/mdns-alias.service`, fill in the name
and the server's LAN IP, then `sudo systemctl enable --now mdns-alias`. The host may also need a
static or reserved LAN IP.

## Trusting the certificate (once per device)

Caddy signs with its own private CA. Download `http://<name>.local/root.crt`, then on iPhone:
Settings > Profile Downloaded > Install, then Settings > General > About > Certificate Trust Settings > enable.
If the name does not resolve at home, turn off Private Relay and Limit IP Address Tracking for that Wi-Fi network.

## After the first account is created

Set `DISABLE_SIGNUP=true` in `.env` and run `docker compose up -d`.

## Checks

- `curl -kI https://<name>.local` returns 200 through Caddy.
- `curl -s https://<name>.local/api/v1/health`
- Port 8000 is not reachable from the LAN.
