#!/usr/bin/env bash
# Installs or updates the helper commands and systemd units, and nothing else. Safe to re-run
# and safe while the Minecraft server is running: it never stops, starts or restarts the game
# and never touches the world. Changes to minecraft.service apply at the server's next restart.
#
# Run on the VM, from a copy of this repo's server/ folder:
#   sudo bash install-helpers.sh
# setup-minecraft.sh runs this too; use it directly to roll out script changes to a live server.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BINS=(mc-cmd mc-console mc-backup mc-allow mc-alert)
UNITS=(minecraft.service minecraft.socket minecraft-backup.service minecraft-backup.timer mc-alert@.service)

die() { printf '\033[1;31m[error] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run with sudo."
id minecraft >/dev/null 2>&1 || die "No 'minecraft' user. Run setup-minecraft.sh first."
for b in "${BINS[@]}"; do [ -f "$SCRIPT_DIR/bin/$b" ] || die "Missing $SCRIPT_DIR/bin/$b. Copy the whole server/ folder to the VM."; done
for u in "${UNITS[@]}"; do [ -f "$SCRIPT_DIR/systemd/$u" ] || die "Missing $SCRIPT_DIR/systemd/$u. Copy the whole server/ folder to the VM."; done
[ -f "$SCRIPT_DIR/install-offsite.sh" ] || die "Missing $SCRIPT_DIR/install-offsite.sh."
for b in "${BINS[@]}"; do bash -n "$SCRIPT_DIR/bin/$b" || die "bin/$b has a syntax error; nothing was installed."; done

for b in "${BINS[@]}"; do install -m 0755 "$SCRIPT_DIR/bin/$b" /usr/local/bin/; done
for u in "${UNITS[@]}"; do install -m 0644 "$SCRIPT_DIR/systemd/$u" /etc/systemd/system/; done

# The Discord webhook for alerts (shared with the dashboard agent). Empty = alerts off.
install -d -o root -g root -m 0755 /etc/mc-agent
[ -f /etc/mc-agent/discord-webhook ] || install -o root -g root -m 0600 /dev/null /etc/mc-agent/discord-webhook

systemctl daemon-reload
bash "$SCRIPT_DIR/install-offsite.sh"
echo "Helpers and units installed. The Minecraft server was not restarted."
