# Hop On SMP dashboard

The friends' control panel: a Next.js 16 app meant for Vercel. It talks to the server only
through the signed agent API (see [../agent](../agent) and
[ADR 0001](../docs/adr/0001-dashboard-security-model.md)).

## Pages

| Page | What it does |
|---|---|
| **Base Camp** | Live status, start/stop/restart, join address with copy, who's on, "Next up" queue, server health (honest free-tier meters), campfire activity log |
| **Worlds** | All worlds with their host. **New world** wizard (name, block icon, mode, difficulty, type, seed, hardcore) |
| **World page** | Overview + switch, "what players need", join steps · Settings (allowlisted only) · **Mod Shop** (Modrinth, Fabric + server version only, "everyone needs it" badges, auto-dependencies, sha512-verified) · Resource pack upload · Backups + restore · Danger zone (reset/delete with typed name) |
| **Console** | Live log (IPs and passwords redacted), safe command list, quick buttons |
| **Crew** | Pixel-face character cards, fun titles with rarity colours, Minecraft-name requests and whitelisting, invites (owner) |
| **Guides** | Joining, what mods are, installing mods with Prism or Fabric, shaders (Iris + Sodium), resource packs, safe vs unsafe download sites, troubleshooting |
| **Logbook** | Audit log (admins + Team Leader) |

**Design:**
- **Theme:** night-camp pixel style.
- **The crew's own artwork** in `public/brand/` (made for the group):
  - The crew logo is used for the header and the favicon.
  - The "HOP ON" poster is used on the login and Crew pages.
- **Pixel faces and world blocks** are drawn in CSS and SVG for this project.
- **No Mojang assets.**
- **Fonts:** three SIL OFL 1.1 fonts, self-hosted by `next/font`:
  - Press Start 2P (headings)
  - Pixelify Sans (text)
  - VT323 (console)

## Run locally (no VM, no Discord)

```bash
# terminal 1: the pretend server
cd agent && cp .env.mock.example .env.mock     # put a key in it
npm run mock

# terminal 2: the dashboard
cd dashboard && cp .env.example .env.local     # same key as the agent, plus a SESSION_SECRET
npm install
npm run dev                                     # http://localhost:3000
```

Generate keys with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

The login page shows **Dev login** buttons for the mock crew. They only exist with
`HOPON_DEV_LOGIN=1` under `next dev`, and never on Vercel.

```bash
npm test          # allowlist + CSRF tests
npm run typecheck
npm run build
```

## Deploy to Vercel

> Don't deploy without the owner's go-ahead. The agent must be installed on the VM and
> reachable through Funnel first.

1. **Create a Discord application**
   ([discord.com/developers/applications](https://discord.com/developers/applications)) →
   OAuth2:
   - Add the redirect `https://<project>.vercel.app/api/auth/callback`.
   - Copy the Client ID, and reset and copy the Client Secret.
2. **Create a Vercel project** from the GitHub repo with **Root Directory = `dashboard`**
   (framework: Next.js).
3. **Set Production environment variables** (not in the repo):

   | Name | Value |
   |---|---|
   | `AGENT_URL` | `https://<machine>.<tailnet>.ts.net` (Funnel) |
   | `NEXT_PUBLIC_AGENT_UPLOAD_ORIGIN` | same as `AGENT_URL` |
   | `AGENT_KEY_ID` | `k1` |
   | `AGENT_HMAC_KEY` | the key from `/etc/mc-agent/hmac-keys` (after `k1:`) |
   | `SESSION_SECRET` | a new random 32-byte base64 value |
   | `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | from step 1 |
   | `DISCORD_REDIRECT_URI` | `https://<project>.vercel.app/api/auth/callback` |
   | `DASHBOARD_ORIGIN` | `https://<project>.vercel.app` |

   Never set `HOPON_DEV_LOGIN` on Vercel. It's ignored there anyway.
4. **On the VM,** set `DASHBOARD_ORIGIN` in `/etc/mc-agent/agent.env` to the same URL, and
   restart the agent.
5. **Deploy, then log in with Discord.** Your account (matching `OWNER_DISCORD_ID`) becomes
   **Team Leader**. Go to **Crew → Invites** to make a link for each friend.

## Security notes

- Every page and API route checks the session itself; `proxy.ts` only adds the CSP nonce.
- `/api/agent/*` forwards only allowlisted method and path pairs (`lib/server/allowlist.mjs`)
  and needs a matching `Origin` plus the `x-csrf-token` header for writes.
- The session cookie is `__Host-hop_session`: HttpOnly, Secure, SameSite=Lax, signed, 14
  days. The agent re-checks the user on every call, so turning someone off works at once.
- Resource packs upload straight to the agent with a one-time ticket, because Vercel functions
  cap bodies at 4.5 MB.
