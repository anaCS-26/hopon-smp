# ADR 0001: Dashboard security model and how Vercel reaches the VM

- **Status:** accepted (not deployed yet)
- **Date:** 2026-11-08
- **Applies to:** `dashboard/` (Next.js on Vercel), `agent/` (control API on the VM)

## Context

The Hop On SMP dashboard is a web control panel for a small group of friends. It runs on
Vercel, and the Minecraft server runs on an Oracle Cloud VM. The dashboard has to start and stop
the server, switch worlds, change settings, install mods and take backups.

Constraints that shape the design:

- **Security is a top priority.** The owner is new to cloud and worried about the VM or the
  Oracle account being taken over.
- **The VM is tiny.** It has 1 OCPU and 6 GB now, 2 and 12 at most. Anything that runs next to
  Minecraft must be light.
- **Vercel's outbound IPs are not fixed**, so the VM firewall cannot allow "only Vercel".
- **Never publish the server IP.** Players already connect through `hopon-smp.duckdns.org` on
  TCP 25565. Nothing else should point at the VM's address.
- **Mods are code.** A mod runs with the Minecraft server's permissions. Anything a friend can
  install must come from a source we can verify.
- **Players use offline mode** (`online-mode=false`). EasyAuth is the only thing that stops
  someone from joining under a friend's name. It must never be removable from the dashboard.

## Decision

### 1. Transport: Tailscale Funnel to an agent bound to localhost

```
Browser ──HTTPS──▶ Vercel (Next.js) ──HTTPS + HMAC──▶ Tailscale Funnel relay ──▶ tailscaled on VM
                                                                                   │
                                                               127.0.0.1:8787 ◀────┘  mc-agent
```

- **The agent listens on `127.0.0.1:8787` only.** Nothing new is opened in the Oracle security
  list or in iptables.
- **Tailscale Funnel publishes it** as `https://<machine>.<tailnet>.ts.net`. `tailscaled`
  connects out to Tailscale's relays, so no inbound port is needed. TLS ends on the VM, so the
  relay cannot read the traffic. The Funnel hostname resolves to Tailscale's relay addresses,
  not to the VM, so it does not reveal the server IP. Use the random tailnet name
  (`tailXXXX.ts.net`), not one based on a personal name.
- **Every `/v1` request is HMAC-signed** (see 2). Funnel is reachable from the whole internet,
  so the signature is what keeps strangers out. Unsigned requests get a `401` before any
  handler runs.
- **The same Funnel also serves two public, unauthenticated paths:**
  - `GET /packs/<sha1>.zip` hands players' clients the world's resource pack. The URL is
    content-addressed and read-only.
  - `GET /healthz` returns `ok` and nothing else.
- **Admin SSH moves to Tailscale too** (already on the roadmap). The public SSH rule can then
  be removed.

### 2. Request signing between Vercel and the agent

- **Key:** a 256-bit key shared by Vercel (env `AGENT_HMAC_KEY`) and the VM
  (`/etc/mc-agent/agent.env`, `root:root 0600`, passed in through systemd `LoadCredential`).
  The agent supports several keys at once (`kid:key,kid:key`), so the key can be rotated with
  no downtime.
- **Signed string:**
  `v1 \n METHOD \n path?query \n timestamp \n nonce \n actor \n sha256(body)`, signed with
  HMAC-SHA256 and compared in constant time.
- **Checks:**
  - The timestamp must be within ±60 s.
  - The nonce must not have been seen in the last 5 minutes (stops replays).
  - The body hash covers the payload.
  - The actor header (`user:<id>:<epoch>` or `system:login`) is part of the signature, so it
    cannot be swapped.
- **Revocation:** the agent loads the user on every request. Disabled users, and sessions with
  an old `epoch`, are rejected, so "log out everywhere" and banning take effect at once.

### 3. The agent is the authority, and the API is an allowlist

- **No shell, no free-form commands.** The web app cannot run arbitrary commands, paths or
  file contents on the VM. The API is a fixed list of routes:
  - status, start, stop, restart
  - allowlisted console commands
  - world create, rename, settings, switch, reset, delete and restore
  - Modrinth mod install and remove
  - resource-pack upload
  - list backups, back up now
  - users, invites and titles
  - the audit log
- **Authorisation runs in the agent** (`agent/src/policy.mjs`), per role (owner, admin, member)
  and per world (host = creator). The dashboard only hides buttons; the agent decides.
- **Console:** text is parsed against an allowlist (`agent/src/console.mjs`) and rebuilt from
  validated parts.
  - Not allowed: `op`, `deop`, `whitelist add`, `ban`, `execute`, `stop`, `reload` and so on.
  - Newlines and control characters are rejected, so one request cannot smuggle in a second
    command.
- **Settings:** only allowlisted `server.properties` keys, each with a type and range check
  (`agent/src/properties.mjs`). The agent and the helper both enforce these keys on every write:
  - `online-mode=false`
  - `white-list=true`
  - `enforce-whitelist=true`
  - `enable-rcon=false`
  - `enable-query=false`
  - `management-server-enabled=false`
  - `level-name=world`
  - `server-port=25565`
- **Whitelisting goes through `mc-allow`**, which stores the offline UUID (v3 of
  `OfflinePlayer:<name>`). The vanilla `whitelist add` and `op` are never used, because they
  look the name up with Mojang and store the wrong UUID.
- **EasyAuth and Fabric API are protected mods.**
  - Neither can be removed.
  - A world without EasyAuth cannot be started.
  - Without EasyAuth, anyone could join as any whitelisted name.

### 4. Mods come from Modrinth only, verified

- **No `.jar` uploads at all.**
- **Installs are by Modrinth version ID.** The agent fetches the version from the Modrinth API
  itself and refuses it unless every check passes:
  - The project type is `mod`.
  - The loaders include `fabric`.
  - The game versions include the server's version.
  - The project is not client-only (`server_side` is not `unsupported`).
  - The primary file is on `cdn.modrinth.com` over HTTPS.
  - The file is at most 64 MB.
- **The download is checked against Modrinth's published sha512** before it touches the server
  folder. Required dependencies are resolved the same way, with a depth limit.

### 5. Resource packs: direct upload with a one-time ticket, strict zip checks

- **Why not through Vercel:** Vercel functions accept at most 4.5 MB of body, so packs cannot
  go through them.
- **The ticket:** the dashboard asks the agent for a ticket over the signed channel. The agent
  checks permission first. The ticket is 256 random bits, lasts 10 minutes, works once, and is
  tied to one user and one world.
- **The upload:** the browser `PUT`s the zip straight to `/v1/uploads/<ticket>`. CORS allows
  only the dashboard's origin.
- **Zip checks** (`agent/src/zip.mjs`, the central directory is parsed without extracting):
  - The size limit is 100 MB, with at most 5,000 entries.
  - The total uncompressed size is at most 512 MB, with a per-entry ratio of at most 100× (zip
    bombs).
  - No `..`, absolute, drive-letter or backslash paths (path traversal).
  - No encryption and no ZIP64.
  - `pack.mcmeta` must be at the root.
- **Serving:** the pack is stored by sha1 and served at `/packs/<sha1>.zip`.
  `server.properties` gets `resource-pack` and `resource-pack-sha1`.

### 6. Least privilege on the VM

| Piece | Runs as | Can do |
|---|---|---|
| Minecraft | `minecraft` (sandboxed unit, already in place) | write `/srv/minecraft` only |
| `mc-agent` | `mcagent` (system user, no login, sandboxed unit, member of group `minecraft` for read-only access to logs and backups) | listen on localhost, read its own state in `/var/lib/mc-agent` |
| `mc-agent-helper` | `minecraft`, via one sudoers rule | a fixed set of file operations (write properties, swap worlds, install a verified jar, tar a backup, move a world to trash), re-validating every argument |
| `systemctl start/stop/restart minecraft.service`, `mc-allow <name>` | root, via exact sudoers lines | nothing else |

- `sudo` resets the environment, so the agent cannot inject `NODE_OPTIONS` or `PATH` into the
  helper.
- The helper's code is root-owned and read-only.
- A compromised mod (running as `minecraft`) cannot change the agent's code, its secret or its
  audit log.
- **The agent has zero npm dependencies** (Node standard library only), so there is no supply
  chain to attack on the VM.

### 7. Dashboard-side controls

- **Login:** Discord OAuth (ADR 0002) with PKCE and a `state` check. It is invite-only, and the
  agent decides who is invited.
- **Session cookie:** `__Host-hop_session`, HttpOnly, Secure, SameSite=Lax, signed with
  `SESSION_SECRET` (Vercel only), lasting 14 days. It holds only the user ID, the epoch and a
  CSRF token.
- **CSRF:** every non-GET request needs both a matching `Origin` and an `x-csrf-token` header
  that equals the session's token.
- **The `/api/agent/*` proxy forwards only allowlisted method and path pairs.** Each route
  handler re-checks the session; we don't rely on Next.js middleware for auth (lesson from
  CVE-2025-29927).
- **Headers:**
  - a strict CSP with a per-request nonce
  - `frame-ancestors 'none'`
  - HSTS
  - `nosniff`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - a Permissions-Policy that denies everything not needed
- **Dev login** (pick a mock user) works only when `NODE_ENV=development`,
  `HOPON_DEV_LOGIN=1` and `VERCEL` is unset.

### 8. Rate limits, audit and backups

- **Rate limits:** token buckets in the agent, per user and per class.
  - `read`: 240/min
  - `write`: 30/min
  - `heavy`: 20/10 min (installs, backups, world create or switch)
  - `login`: 20/min
- **One heavy job at a time.** A switch, install or backup takes a lock and shows in the status
  as "busy: …".
- **Audit log:** every write and every denied write is appended to
  `/var/lib/mc-agent/audit.jsonl` with the time, actor, action, target and result. The agent
  user owns the file. There is no API to delete or edit it.
- **Backups before anything destructive.** World delete, reset and restore, mod removal and
  software upgrades take an automatic backup first, and abort if the backup fails.
  - Deleting a world moves it to `/srv/minecraft/trash`; it is not `rm -rf`.
  - Destructive actions need the world's name typed in.
  - Minecraft version downgrades are never offered or accepted.

### 9. Secrets

| Secret | Where |
|---|---|
| `AGENT_HMAC_KEY` | Vercel env + `/etc/mc-agent/agent.env` (root 0600) |
| `SESSION_SECRET` | Vercel env only |
| `DISCORD_CLIENT_SECRET` | Vercel env only |
| `DISCORD_WEBHOOK_URL` (optional) | `/etc/mc-agent/agent.env` only |
| Funnel hostname | Vercel env `AGENT_URL`. Not secret, but kept out of the repo |

The repo contains only `*.example` files. Generate keys with
`openssl rand -base64 32` (or the PowerShell snippet in the README).

## Threats and what limits them

| Threat | Result |
|---|---|
| Internet scanner finds the Funnel URL | Gets `401` without a valid HMAC. Sees only `/healthz` and content-addressed packs. |
| Stolen session cookie | HttpOnly, so scripts can't read it, and Secure. The owner can bump the user's epoch ("log out everywhere") or disable them. |
| A friend's account misused | Can only do what their role and world allow. Can't touch other hosts' worlds, can't run arbitrary commands, can't upload code. Everything is audited. |
| CSRF from another site | SameSite cookie + Origin check + CSRF header. |
| Malicious mod | Only verified Modrinth builds. Still runs as the sandboxed `minecraft` user that can't reach the agent's secret. |
| Zip bomb or traversal pack | Rejected before storage. Never extracted on the VM. |
| **Vercel compromised or `AGENT_HMAC_KEY` leaked** | **Accepted risk.** The attacker can act as any dashboard user, including the owner, *but only through the allowlisted API*: no shell, can't disable EasyAuth or change `online-mode`, can't delete backups or the audit log, can't install non-Modrinth code. Recovery: rotate the key (README), review the audit log, restore from backups. |
| VM exposed by IP | The Funnel hostname doesn't resolve to the VM. No new ports are opened. |

## Alternatives considered

1. **HTTPS on a DuckDNS name with HMAC + mTLS (Caddy in front).** Works, and mTLS keeps
   strangers away from the HTTP parser. But it opens a new public port on the Oracle security
   list that can't be IP-restricted (Vercel IPs move), and the certificate needs port 80 or the
   DuckDNS token on the VM. **This is the fallback** if Funnel is ever unavailable: the agent
   code doesn't change, only Caddy and one security-list rule are added.
2. **Cloudflare Tunnel + Access service token.** Excellent, but it needs a domain on
   Cloudflare (DuckDNS names can't be used) and another account. A good upgrade if a domain is
   bought.
3. **No public agent (the VM polls a queue).** No inbound path at all, but it needs a broker
   (Upstash or Vercel KV). Polling every few seconds would use up Vercel Hobby's function
   allowance, and pack uploads would need separate storage.
4. **Vercel joins the tailnet directly.** Not practical for serverless functions.
5. **SSH from Vercel to the VM.** Rejected: it is shell access.

## Consequences

- Tailscale must be installed on the VM before the dashboard can go live (already planned for
  admin SSH).
- Players' clients download resource packs from the `ts.net` hostname. That reveals the tailnet
  name, but not the IP.
- If the VM is down, the dashboard shows "Agent offline" and nobody can log in, because users
  live on the VM. That's acceptable: without the VM there's nothing to control.
