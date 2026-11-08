# mc-agent: the server's control API

A small program that runs **on the Minecraft VM** and lets the dashboard do a fixed list of
things: start, stop and restart, switch worlds, change allowlisted settings, install Modrinth
mods, upload resource packs, take backups, manage the crew. It is the only way the dashboard can
touch the server. There is no shell and no "run any command".

- **Zero npm dependencies.** It uses only Node.js's standard library, so there is no
  third-party code on the VM.
- **Listens on `127.0.0.1:8787` only.** Tailscale Funnel publishes it over HTTPS
  ([ADR 0001](../docs/adr/0001-dashboard-security-model.md)).
- **Every `/v1` request must be HMAC-signed** by the dashboard. The agent re-checks the user and
  their permission on every call.
- **Runs as `mcagent`,** an unprivileged user. Exact `sudo` rules let it do only three
  privileged things ([install/sudoers.mc-agent](install/sudoers.mc-agent)):
  - start, stop or restart `minecraft.service`
  - run `mc-allow <name>` for one valid name, through the root-owned
    [allow-player](install/allow-player) wrapper (never `--op`)
  - run the [helper](helper/mc-agent-helper.mjs), which does a fixed set of file operations
    as `minecraft`

## Layout

```
src/
  main.mjs          entry point (real or --mock)
  http.mjs          signature check, rate limits, routing
  service.mjs       every action: permission check, validation, backup-first, audit
  policy.mjs        who may do what (roles: owner/admin/member, plus world host)
  hmac.mjs          request signing (shared format with dashboard/lib/server/agent.ts)
  properties.mjs    server.properties allowlist + always-enforced security keys
  console.mjs       console command allowlist
  modrinth.mjs      Modrinth search/install filters + sha512 verification
  zip.mjs           resource-pack zip inspection (no extraction)
  system-real.mjs   the VM: systemctl, mc-cmd, mc-allow, helper via sudo
  system-mock.mjs   a pretend VM for local development
helper/mc-agent-helper.mjs   privileged file operations, run as `minecraft`
install/                     installer, systemd unit, sudoers rules, config template
test/                        node --test suites (no dependencies)
```

## Run it locally (mock mode, no VM)

```bash
cd agent
cp .env.mock.example .env.mock     # then put a key in it, see the comment at the top
npm run mock                       # real Modrinth search; pretend VM
npm run mock -- --offline          # no internet needed (fixture mods)
npm test                           # 60 tests: signing, permissions, allowlists, zip checks, helper
```

Mock mode seeds a crew (Leader, Zbeast, PixelPanda, MossyMax), three worlds and some backups.
Start and stop take a few seconds, and fake players wander in and out.

## Install on the VM

> Don't do this until you've approved it. It adds a user, a service and sudo rules on the live
> server. It doesn't restart Minecraft or touch the world.

Requirements:

- `server/setup-minecraft.sh` has already been run.
- `/usr/local/bin/mc-allow` is installed.
- Ubuntu 24.04 or newer (Node.js 20+ from apt). The sudo rules parse under both classic sudo
  and sudo-rs, the default from Ubuntu 25.10; the installer checks them with every `visudo`
  it finds.

1. **Copy the `agent/` folder to the VM** (from your laptop, in the repo folder):
   ```bash
   scp -r agent ubuntu@<vm>:~/
   ```
2. **Run the installer:**
   ```bash
   sudo bash ~/agent/install/install-agent.sh
   ```
3. **Fill in `/etc/mc-agent/agent.env`:**
   - `AGENT_PUBLIC_URL` (step 5)
   - `DASHBOARD_ORIGIN` (your Vercel URL)
   - `OWNER_DISCORD_ID`
   ```bash
   sudo nano /etc/mc-agent/agent.env
   sudo systemctl restart mc-agent
   curl http://127.0.0.1:8787/healthz       # {"ok":true}
   ```
4. **Install Tailscale** (also planned for admin SSH), and log in:
   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```
   In the [Tailscale admin console](https://login.tailscale.com/admin):
   - **DNS:** enable MagicDNS and HTTPS certificates.
   - **Access controls:** allow Funnel for this machine (the console offers a one-click
     "Funnel" policy).
   - Prefer the random tailnet name (`tailXXXX.ts.net`).
5. **Publish only the agent's port:**
   ```bash
   sudo tailscale funnel --bg 8787
   tailscale funnel status          # shows https://<machine>.<tailnet>.ts.net
   ```
   Put that URL in `AGENT_PUBLIC_URL`, restart the agent, and check
   `https://<machine>.<tailnet>.ts.net/healthz` from your laptop.
6. **Give Vercel the key.** It lives in `/etc/mc-agent/hmac-keys` as `k1:<key>`, and the
   installer never prints it. Run `sudo cat /etc/mc-agent/hmac-keys` and set two Vercel env
   vars:
   - `AGENT_KEY_ID=k1`
   - `AGENT_HMAC_KEY=<the part after k1:>`

Optional: put a Discord webhook URL in `/etc/mc-agent/discord-webhook` to post "server is
online" and "switched worlds" messages to a channel.

### First run: adopting the current world

The first time the agent starts, it adopts the existing `/srv/minecraft/server/world` as the
world **"Hop On SMP"**. It writes the marker file `server/.hopon-active` and nothing else, and
the world gets hosted by the Team Leader on their first login. New worlds go to
`/srv/minecraft/worlds/<id>/`. Switching renames folders while the server is stopped, so
`mc-backup`, the backup timer and `minecraft.service` all keep working unchanged.

### Rotating the key

1. Add a second key on the same line of `/etc/mc-agent/hmac-keys`:
   `k1:<old>,k2:<new>` (generate with `head -c 32 /dev/urandom | base64`).
2. Restart the agent.
3. Change Vercel to `AGENT_KEY_ID=k2` and the new key, then redeploy.
4. Remove `k1` and restart the agent.

### Checking it

```bash
systemctl status mc-agent
journalctl -u mc-agent -n 50
sudo tail -n 20 /var/lib/mc-agent/audit.jsonl       # who did what
sudo -l -U mcagent                                  # the only sudo rules it has
```

## What's verified, what isn't

- **Verified locally:** everything under `test/` (`npm test`), the mock agent end to end with
  the dashboard, and the sudoers file and systemd unit syntax (`visudo -c`,
  `systemd-analyze verify`).
- **Not yet run on the real VM:**
  - The installer.
  - The sandboxed unit together with sudo.
  - Funnel.
  - The game-rule names on 26.x (`console.mjs` has a note about these).

  Do the first install with someone watching `journalctl -u mc-agent -f`.
