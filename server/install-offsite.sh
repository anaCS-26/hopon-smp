#!/usr/bin/env bash
# Installs the encrypted off-site backup job (mc-offsite). Safe to re-run, and safe while the
# Minecraft server is running: it does not touch the server, the world or the local backups.
#
# Run on the VM, from a copy of this repo's server/ folder:
#   sudo bash install-offsite.sh
#
# What it does
#   * Installs rclone from Ubuntu's packages
#   * Creates a locked-down 'mc-offsite' system user (no sudo, no login) that can read the
#     backups folder. The Drive login and passphrase live in /var/lib/mc-offsite (0700),
#     which the 'minecraft' user, and so the game server and its mods, cannot read.
#   * Installs /usr/local/bin/mc-offsite and a daily systemd timer
#
# The timer does nothing until Google Drive is connected: docs/offsite-backups.md
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR=/var/lib/mc-offsite

die() { printf '\033[1;31m[error] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run with sudo."
id minecraft >/dev/null 2>&1 || die "No 'minecraft' user. Run setup-minecraft.sh first."
for f in bin/mc-offsite systemd/minecraft-offsite.service systemd/minecraft-offsite.timer; do
  [ -f "$SCRIPT_DIR/$f" ] || die "Missing $SCRIPT_DIR/$f. Copy the whole server/ folder to the VM."
done

if ! command -v rclone >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y rclone
fi

if ! id mc-offsite >/dev/null 2>&1; then
  useradd --system --home-dir "$STATE_DIR" --no-create-home --shell /usr/sbin/nologin --user-group mc-offsite
fi
usermod -aG minecraft mc-offsite
install -d -o mc-offsite -g mc-offsite -m 0700 "$STATE_DIR"

install -m 0755 "$SCRIPT_DIR/bin/mc-offsite" /usr/local/bin/
install -m 0644 "$SCRIPT_DIR/systemd/minecraft-offsite.service" "$SCRIPT_DIR/systemd/minecraft-offsite.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now minecraft-offsite.timer

if [ -f "$STATE_DIR/rclone.conf" ]; then
  echo "Off-site backups installed. Check them with: sudo mc-offsite status"
else
  cat <<EOF
Off-site backups installed, but not connected to Google Drive yet.
Follow docs/offsite-backups.md:
  sudo mc-offsite setup-drive     (connect Google Drive)
  sudo mc-offsite setup-crypt     (set the encryption passphrase)
  sudo mc-offsite                 (first upload)
EOF
fi
