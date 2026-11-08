#!/usr/bin/env bash
# Install or update the Hop On SMP dashboard agent on the Minecraft VM.
# Run from a copy of this repo's agent/ folder, AFTER server/setup-minecraft.sh:
#   sudo bash agent/install/install-agent.sh
#
# What it does (safe to re-run; it never touches the world or the Minecraft service):
#   * installs Node.js from Ubuntu (if missing or older than 20)
#   * creates the 'mcagent' system user (no login, no sudo except the rules below)
#   * copies the agent to /opt/mc-agent (root-owned, read-only to the agent)
#   * creates /var/lib/mc-agent (state + audit log) and /etc/mc-agent (config + secrets)
#   * generates the HMAC key once (root 0600) - you copy it into Vercel yourself
#   * installs /etc/sudoers.d/mc-agent after checking it with visudo
#   * installs and starts mc-agent.service, listening on 127.0.0.1:8787 only
# It does NOT install Tailscale or open any port. See the README for that step.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
log()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[warn] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[error] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run with sudo."
id minecraft >/dev/null 2>&1 || die "No 'minecraft' user. Run server/setup-minecraft.sh first."
[ -d /srv/minecraft/server ] || die "/srv/minecraft/server not found. Run server/setup-minecraft.sh first."
for b in mc-cmd mc-backup mc-allow; do
  [ -x "/usr/local/bin/$b" ] || die "/usr/local/bin/$b is missing. Install the server helpers first."
done
for f in src/main.mjs helper/mc-agent-helper.mjs install/mc-agent.service install/sudoers.mc-agent install/allow-player install/agent.env.example; do
  [ -f "$SRC/$f" ] || die "Missing $SRC/$f. Copy the whole agent/ folder to the VM."
done
# Ubuntu 25.10+ uses sudo-rs by default and may also ship classic sudo as sudo.ws. The rules
# file must parse under every sudo present, or a bad file could break sudo for everyone.
visudos=()
for v in /usr/sbin/visudo /usr/sbin/visudo.ws /usr/bin/visudo-rs; do
  [ -x "$v" ] && visudos+=("$(readlink -f "$v")")
done
[ "${#visudos[@]}" -gt 0 ] || die "No visudo found; can't check the sudo rules safely."
mapfile -t visudos < <(printf '%s\n' "${visudos[@]}" | sort -u)
sudo -V | head -n1

log "Node.js"
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ "$(node_major)" -lt 20 ]; then
  apt-get update -y
  apt-get install -y nodejs
fi
[ "$(node_major)" -ge 20 ] || die "Node.js 20+ is required; Ubuntu gave $(node -v 2>/dev/null || echo none)."
[ "$(command -v node)" = /usr/bin/node ] || die "node must be /usr/bin/node (the sudoers rule names that path)."
node -v

log "User and folders"
if ! id mcagent >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/mc-agent --no-create-home --shell /usr/sbin/nologin --user-group mcagent
fi
usermod -aG minecraft mcagent
install -d -o mcagent -g mcagent -m 0711 /var/lib/mc-agent
install -d -o mcagent -g minecraft -m 2750 /var/lib/mc-agent/staging   # helper (minecraft) reads verified jars here
install -d -o mcagent -g mcagent -m 0750 /var/lib/mc-agent/packs
install -d -o root -g root -m 0755 /etc/mc-agent

log "Copying the agent to /opt/mc-agent"
rm -rf /opt/mc-agent.new
install -d -o root -g root -m 0755 /opt/mc-agent.new /opt/mc-agent.new/src /opt/mc-agent.new/helper
install -o root -g root -m 0644 "$SRC"/src/*.mjs /opt/mc-agent.new/src/
install -o root -g root -m 0644 "$SRC"/helper/mc-agent-helper.mjs /opt/mc-agent.new/helper/
install -o root -g root -m 0644 "$SRC"/package.json /opt/mc-agent.new/
rm -rf /opt/mc-agent.old
[ -d /opt/mc-agent ] && mv /opt/mc-agent /opt/mc-agent.old
mv /opt/mc-agent.new /opt/mc-agent
rm -rf /opt/mc-agent.old

log "Configuration and secrets"
if [ ! -f /etc/mc-agent/agent.env ]; then
  install -o root -g root -m 0644 "$SRC/install/agent.env.example" /etc/mc-agent/agent.env
  warn "Edit /etc/mc-agent/agent.env (AGENT_PUBLIC_URL, DASHBOARD_ORIGIN, OWNER_DISCORD_ID), then: sudo systemctl restart mc-agent"
fi
if [ ! -f /etc/mc-agent/hmac-keys ]; then
  umask 077
  printf 'k1:%s\n' "$(head -c 32 /dev/urandom | base64 -w0)" > /etc/mc-agent/hmac-keys
  umask 022
  echo "Generated a new HMAC key in /etc/mc-agent/hmac-keys (not printed)."
fi
[ -f /etc/mc-agent/discord-webhook ] || install -o root -g root -m 0600 /dev/null /etc/mc-agent/discord-webhook
chown root:root /etc/mc-agent/hmac-keys /etc/mc-agent/discord-webhook
chmod 0600 /etc/mc-agent/hmac-keys /etc/mc-agent/discord-webhook

log "sudo rules"
install -d -o root -g root -m 0755 /usr/local/lib/mc-agent
install -o root -g root -m 0755 "$SRC/install/allow-player" /usr/local/lib/mc-agent/allow-player
tmp="$(mktemp)"
install -m 0440 "$SRC/install/sudoers.mc-agent" "$tmp"
for v in "${visudos[@]}"; do
  "$v" -c -f "$tmp" >/dev/null || { rm -f "$tmp"; die "sudoers.mc-agent failed $v's check; not installed."; }
done
install -o root -g root -m 0440 "$tmp" /etc/sudoers.d/mc-agent
rm -f "$tmp"

log "systemd service"
install -o root -g root -m 0644 "$SRC/install/mc-agent.service" /etc/systemd/system/mc-agent.service
systemctl daemon-reload
systemctl enable mc-agent.service >/dev/null
if grep -q REPLACE /etc/mc-agent/agent.env; then
  warn "Not starting yet: /etc/mc-agent/agent.env still has REPLACE placeholders."
else
  systemctl restart mc-agent.service
  sleep 2
  systemctl --no-pager --lines=5 status mc-agent.service || true
  curl -fsS http://127.0.0.1:8787/healthz && echo
fi

cat <<'EOF'

Next steps (see agent/README.md):
  1. Fill in /etc/mc-agent/agent.env, then: sudo systemctl restart mc-agent
  2. Copy the key into Vercel (AGENT_KEY_ID=k1, AGENT_HMAC_KEY=<the part after "k1:">):
       sudo cat /etc/mc-agent/hmac-keys
  3. Publish the agent with Tailscale Funnel (only after you approve installing Tailscale):
       sudo tailscale funnel --bg 8787
  4. Check from your laptop: https://<machine>.<tailnet>.ts.net/healthz  ->  {"ok":true}
EOF
