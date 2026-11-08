# Dashboard go-live runbook

How the Hop On SMP dashboard goes from "works on the laptop" to "friends use it".

- Steps marked **YOU** need the owner: their accounts, their clicks, their secrets.
- Steps marked **AGENT** can be done by a Claude session, after the owner says go.

Background: [ADR 0001](adr/0001-dashboard-security-model.md),
[agent/README.md](../agent/README.md), [dashboard/README.md](../dashboard/README.md).

## Ground rules (for any agent doing this)

- **Ask before each phase.**
  - Phase 1 installs software on the live VM.
  - Phase 3 deploys to Vercel.
- **Secrets never pass through chat or logs.** Don't print, echo or paste them:
  - the HMAC key
  - `SESSION_SECRET`
  - the Discord client secret

  The owner pastes them into the Vercel dashboard. Non-secret env vars can be set by the
  agent.
- **Never write the VM's IP anywhere public**, including the repo, PR text and Vercel
  settings.
- Don't touch `infra/oci/*` or `server/setup-minecraft.sh`; another session owns them.
- **Never upgrade the Oracle account** and never create VM shapes.
- **Which VM:** friends currently play on the temporary `mc-temp` VM (trial credit, deleted
  around 2026-12-08). Install on `mc-temp` now. When the world moves to the free Arm VM:
  - Re-run the installer there.
  - Copy `/var/lib/mc-agent/` (users, worlds, audit log) and `/etc/mc-agent/`.
  - Move the Tailscale node.

  Add this to the migration checklist.

---

## Lessons from the first go-live (2026-11-08, on `mc-temp`)

Read these before re-running the runbook (for example on the Arm VM):

- **Ubuntu 26.04 uses sudo-rs as `sudo`.** Classic sudo is also installed, as `sudo.ws`.
  - sudo-rs rejects `requiretty` and regex arguments.
  - The agent's rules file now parses under both, and the installer checks it with every
    `visudo` it finds.
- **Tailscale has `resolute` (26.04) packages,** so the commands in 1b work unchanged.
- **Copy only committed files to the VM.** Use `git archive` rather than `scp -r agent`, so no
  local `.env.mock` goes up:
  `git archive --format=tar.gz -o agent.tgz HEAD agent`, copy it with scp, then `tar -xzf` in `~`.
- **SSH from Git Bash:** the Oracle key has a passphrase and lives in Windows' ssh-agent. Use
  Windows' `C:\Windows\System32\OpenSSH\ssh.exe`, not Git Bash's `ssh`.
- **Vercel:** the Vercel connection Claude had could read the team but not create projects or
  change settings. So the owner did these in the website:
  - importing the repo
  - setting env vars
  - adding domains
  - redeploying

  **The project name Vercel shows on import is what you get.** The repo was imported as
  `hoponsmp`, so the live URL is `https://hoponsmp.vercel.app`, and `hopon-smp.vercel.app`
  belongs to someone else. Check the Domains list right after import, before setting
  `DASHBOARD_ORIGIN`, `DISCORD_REDIRECT_URI` or the Discord redirect.
- **The Funnel host is kept out of the repo by design.** It isn't secret. It lives in Vercel's
  `AGENT_URL` and in `/etc/mc-agent/agent.env` on the VM.

## Phase 0: get the code ready (AGENT)

1. **Merge the dashboard work into the main branch.** It lives on branch
   `claude/dashboard-154d88`.
   - Push it and open a PR, with the owner's OK.
   - The repo is meant to become public on GitHub (account anaCS-26). If there's no remote
     yet, ask the owner whether to create it now (`gh repo create`) or deploy from the CLI
     instead.
2. **Get `server/bin/mc-allow` committed** (it's on the VM and in the main checkout's working
   tree, but not committed). The main session (`local_ef5e7e20…`) owns `server/`; ask it.
   `install-agent.sh` refuses to run without `/usr/local/bin/mc-allow` on the VM.
3. **Run the tests:** `cd agent && npm test` and `cd dashboard && npm test && npm run build`.

## Phase 1: VM, Tailscale and the agent

### 1a. YOU: make a Tailscale account (2 min)
1. Go to <https://login.tailscale.com/start> and sign up. Use the same Google, Microsoft or
   GitHub login you use for important things, with two-factor on. It's free.
2. You don't need to install Tailscale on your laptop for the dashboard. (You will later, for
   private SSH.)

### 1b. AGENT: install Tailscale on the VM
SSH in (from the owner's laptop, as in `infra/oci`) and install from Tailscale's signed apt
repository. Don't pipe a script into the shell:

```bash
curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/$(. /etc/os-release; echo $VERSION_CODENAME).noarmor.gpg | sudo tee /usr/share/keyrings/tailscale-archive-keyring.gpg >/dev/null
curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/$(. /etc/os-release; echo $VERSION_CODENAME).tailscale-keyring.list | sudo tee /etc/apt/sources.list.d/tailscale.list
sudo apt-get update && sudo apt-get install -y tailscale
sudo tailscale up --hostname=hopon-smp
```

If Tailscale has no packages for 26.04's codename yet, use the newest supported one (`noble`)
and say so. `tailscale up` prints a login link.

### 1c. YOU: approve the VM in Tailscale (1 min)
1. Open the link the agent gives you and log in. Then click **Connect**.
2. In the admin console (<https://login.tailscale.com/admin>):
   - **DNS** tab → make sure **MagicDNS** is on → scroll to **HTTPS Certificates** →
     **Enable**.
   - **DNS** tab → **Tailnet name** → **Rename tailnet…** → pick one of the random
     `tailXXXX.ts.net` suggestions, so your name isn't in the URL.
   - **Machines** → `hopon-smp` → **⋯** → **Disable key expiry**, so the server doesn't drop
     off in 6 months.

### 1d. YOU: two values the agent needs (not secrets)
- **Your Discord user ID:**
  1. In Discord, go to **Settings → Advanced → Developer Mode: on**.
  2. Close settings, right-click your own name in any member list, and choose **Copy User
     ID**. It's a long number.
- **The dashboard name you want:** e.g. `hopon-smp` → `https://hopon-smp.vercel.app`. The
  agent checks it's free.

### 1e. AGENT: install the agent
```bash
scp -r agent <user>@<vm>:~/                # from the repo folder on the laptop
ssh <user>@<vm> 'sudo bash ~/agent/install/install-agent.sh'
```
Then edit `/etc/mc-agent/agent.env` on the VM:
- `OWNER_DISCORD_ID` (from 1d)
- `DASHBOARD_ORIGIN=https://<name>.vercel.app`
- `AGENT_PUBLIC_URL` (after 1g)

### 1f. AGENT: turn on Funnel for the agent's port only
```bash
sudo tailscale funnel --bg 8787
tailscale funnel status
```
The first time, this prints a link saying Funnel isn't enabled for the tailnet.

### 1g. YOU: allow Funnel (1 min)
Open that link and click **Enable**. This adds the `funnel` permission to your tailnet's access
rules. Tell the agent when it's done.

### 1h. AGENT: finish and check
1. Put `https://hopon-smp.<tailnet>.ts.net` into `AGENT_PUBLIC_URL`, then
   `sudo systemctl restart mc-agent`.
2. Check:
   - `curl https://hopon-smp.<tailnet>.ts.net/healthz` from the laptop → `{"ok":true}`.
   - `curl -i https://…/v1/status` → `401` (unsigned requests are refused).
   - `journalctl -u mc-agent -n 50` is clean.
   - The world was adopted as "Hop On SMP": `/srv/minecraft/server/.hopon-active` contains
     `hopon`.
   - The Minecraft server is still running and players can join. The installer doesn't
     restart it.
3. Watch for the unverified bits:
   - the sandboxed unit plus sudo
   - `mc-allow` through sudo
   - backup and restore through the helper
   - the game-rule names on 26.x

## Phase 2: Discord login app

### 2a. YOU: create the Discord app (5 min)
1. Go to <https://discord.com/developers/applications> → **New Application** → name it
   `Hop On SMP` → agree → **Create**.
2. Left menu → **OAuth2**.
3. **Client ID** → **Copy**. Send this to the agent; it's not secret.
4. **Client Secret** → **Reset Secret** → **Copy**. Don't send it in chat. Keep it in your
   clipboard or password manager for step 3b.
5. **Redirects** → **Add Redirect** → `https://<name>.vercel.app/api/auth/callback` (exactly)
   → **Save Changes**.

## Phase 3: Vercel

### 3a. AGENT: create the project
- Create the Vercel project from the GitHub repo:
  - **Root Directory** = `dashboard`
  - framework Next.js
  - name from 1d
- Set the non-secret Production env vars:

| Name | Value |
|---|---|
| `AGENT_URL` | `https://hopon-smp.<tailnet>.ts.net` |
| `NEXT_PUBLIC_AGENT_UPLOAD_ORIGIN` | same |
| `AGENT_KEY_ID` | `k1` |
| `DISCORD_CLIENT_ID` | from 2a |
| `DISCORD_REDIRECT_URI` | `https://<name>.vercel.app/api/auth/callback` |
| `DASHBOARD_ORIGIN` | `https://<name>.vercel.app` |

Never set `HOPON_DEV_LOGIN`.

### 3b. YOU: paste the three secrets into Vercel (5 min)
Go to Vercel → your project → **Settings → Environment Variables**. For each one: add it,
tick **Production** only, and turn **Sensitive** on.

1. **`AGENT_HMAC_KEY`**: in PowerShell on your laptop, run
   ```powershell
   ssh <user>@<vm> "sudo cat /etc/mc-agent/hmac-keys"
   ```
   It prints `k1:SOMETHING`. Paste only the part **after** `k1:`.
2. **`SESSION_SECRET`**: in PowerShell, run
   ```powershell
   $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Fill($b); [Convert]::ToBase64String($b)
   ```
   and paste the output.
3. **`DISCORD_CLIENT_SECRET`**: the secret from 2a.

Then clear your clipboard (copy any other text) and close the PowerShell window.

### 3c. AGENT: deploy (after the owner's go)
1. Deploy to production.
2. Check:
   - The response headers include the CSP, HSTS and `X-Frame-Options: DENY`.
   - `/login` loads with the poster.
   - The dev-login box is **absent**.

### 3d. YOU: first login
1. Open `https://<name>.vercel.app` → **Log in with Discord** → **Authorize**. You should land
   on Base Camp as **Team Leader**.
2. **Crew → Your Minecraft name:** type yours exactly → Save → **Approve** it on your own
   card.
3. **Crew → Invites:** make one link per friend (pick a fun title for each). Send each link
   privately. Each friend:
   1. opens the link and logs in with Discord
   2. types their Minecraft name on the Crew page

   Then you press **Approve**.

## Phase 4: after go-live (separate tasks)

- **Close public SSH:** once you SSH over Tailscale, remove the port-22 rule from the Oracle
  security list. That's in the main session's roadmap.
- **Optional:** a Discord channel webhook for "server online" and "world switched" posts. Put
  the URL in `/etc/mc-agent/discord-webhook` (root 0600), then restart `mc-agent`.
- **Migration:** add the agent steps to the `mc-temp` → Arm VM migration checklist (see
  "Which VM" above).
- **Key rotation:** see [agent/README.md](../agent/README.md#rotating-the-key).
