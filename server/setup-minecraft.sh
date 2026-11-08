#!/usr/bin/env bash
# Installs a Minecraft Java server on an Oracle Cloud Always Free Arm VM
# (Ubuntu 24.04 / 26.04, VM.Standard.A1.Flex, 2 OCPU / 12 GB).
#
# Run on the VM, from a copy of this repo's server/ folder:
#   sudo ACCEPT_EULA=yes MC_VERSION=26.3 SOFTWARE=fabric ONLINE_MODE=false bash setup-minecraft.sh
#
#   SOFTWARE     fabric | paper | vanilla          (default fabric)
#   MC_VERSION   e.g. 26.3. Same as the world's version or newer, never older.
#   ONLINE_MODE  true  = Microsoft accounts only
#                false = cracked launchers allowed (EasyAuth is installed on Fabric)
#                Required on first install. Must match the world's previous server,
#                or player inventories appear empty (they are stored per player UUID).
#   HEAP         Java heap, default 6G (half the VM; leaves room for a test server later)
#   DIFFICULTY / GAMEMODE / HARDCORE   first install only; default normal / survival / false
#                (gamerules such as pvp or keep_inventory live in the world and carry over)
#   ACCEPT_EULA  must be "yes": https://aka.ms/MinecraftEULA
#
# What it does
#   * Java 25 from Ubuntu's OpenJDK packages (Eclipse Temurin as a fallback)
#   * Automatic security updates
#   * Opens TCP 25565 in the VM firewall, above Oracle's default REJECT rule
#   * A locked-down 'minecraft' system user (no sudo, no login); server in /srv/minecraft/server
#   * Downloads the server and mods, verifying published checksums
#   * systemd: sandboxed server service, console pipe, 6-hourly local backup timer
#   * Helpers in /usr/local/bin: mc-cmd, mc-console, mc-backup
#
# Guardrails (safe to re-run)
#   * Never modifies the world folder. Takes a "pre-setup" backup if a world exists.
#   * Refuses to run while the server is running.
#   * Refuses to install an older Minecraft version than the one installed.
#   * Refuses to switch server software or flip online-mode on an existing install unless
#     ALLOW_SOFTWARE_CHANGE=yes / ALLOW_ONLINE_MODE_CHANGE=yes.
#   * Does not start the server.

set -euo pipefail

SOFTWARE="${SOFTWARE:-fabric}"
MC_VERSION="${MC_VERSION:-}"
ONLINE_MODE="${ONLINE_MODE:-}"
HEAP="${HEAP:-6G}"
JAVA_MAJOR="${JAVA_MAJOR:-25}"
ACCEPT_EULA="${ACCEPT_EULA:-no}"
FABRIC_MODS="${FABRIC_MODS:-fabric-api lithium ferrite-core}"
ALLOW_SOFTWARE_CHANGE="${ALLOW_SOFTWARE_CHANGE:-no}"
ALLOW_ONLINE_MODE_CHANGE="${ALLOW_ONLINE_MODE_CHANGE:-no}"
UA="anaCS-26/minecraft-oracle-server/1.0"

MC_HOME=/srv/minecraft
SERVER_DIR="$MC_HOME/server"
BACKUP_DIR="$MC_HOME/backups"
STATE_FILE="$SERVER_DIR/.install-state"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[warn] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[error] %s\033[0m\n' "$*" >&2; exit 1; }

as_mc() { runuser -u minecraft -- "$@"; }
state_get() { [ -f "$STATE_FILE" ] && grep -m1 "^$1=" "$STATE_FILE" | cut -d= -f2- || true; }
version_lt() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1)" = "$1" ]; }

# Download $1 to $2, verifying $4 checksum of type $3 (sha1|sha256|sha512) when given.
fetch() {
  local url="$1" dest="$2" algo="${3:-}" sum="${4:-}" tmp
  tmp="$(mktemp)"
  curl -fsSL -A "$UA" -o "$tmp" "$url"
  if [ -n "$algo" ] && [ -n "$sum" ]; then
    echo "$sum  $tmp" | "${algo}sum" -c --status || { rm -f "$tmp"; die "Checksum mismatch for $url"; }
  else
    warn "No published checksum for $(basename "$dest"); relying on HTTPS"
  fi
  install -o minecraft -g minecraft -m 0640 "$tmp" "$dest"
  rm -f "$tmp"
}

# ---------------------------------------------------------------------------
# Preflight
[ "$(id -u)" -eq 0 ] || die "Run with sudo."
ADMIN_USER="${SUDO_USER:-}"
[ "$(uname -m)" = "aarch64" ] || warn "Expected an Arm (aarch64) VM, found $(uname -m)"
[ "$ACCEPT_EULA" = "yes" ] || die "Set ACCEPT_EULA=yes to accept Mojang's EULA (https://aka.ms/MinecraftEULA)."
[ -n "$MC_VERSION" ] || die "Set MC_VERSION, e.g. MC_VERSION=26.3"
case "$SOFTWARE" in fabric|paper|vanilla) ;; *) die "SOFTWARE must be fabric, paper or vanilla" ;; esac
[[ "$HEAP" =~ ^[0-9]+[GM]$ ]] || die "HEAP must look like 6G or 6144M"
for f in bin/mc-cmd bin/mc-console bin/mc-backup systemd/minecraft.service systemd/minecraft.socket \
         systemd/minecraft-backup.service systemd/minecraft-backup.timer; do
  [ -f "$SCRIPT_DIR/$f" ] || die "Missing $SCRIPT_DIR/$f. Copy the whole server/ folder to the VM."
done

if systemctl is-active --quiet minecraft 2>/dev/null; then
  die "The server is running. Stop it first: sudo systemctl stop minecraft"
fi

prev_software="$(state_get software)"
prev_version="$(state_get mc_version)"
prev_online="$(state_get online_mode)"
if [ -z "$prev_online" ] && [ -f "$SERVER_DIR/server.properties" ]; then
  prev_online="$(grep -m1 '^online-mode=' "$SERVER_DIR/server.properties" | cut -d= -f2- || true)"
fi

if [ -n "$prev_version" ] && version_lt "$MC_VERSION" "$prev_version"; then
  die "Refusing to downgrade from $prev_version to $MC_VERSION. Worlds cannot be downgraded safely."
fi
if [ -n "$prev_software" ] && [ "$prev_software" != "$SOFTWARE" ] && [ "$ALLOW_SOFTWARE_CHANGE" != "yes" ]; then
  die "Installed software is $prev_software, not $SOFTWARE. Back up, then re-run with ALLOW_SOFTWARE_CHANGE=yes."
fi
if [ -z "$ONLINE_MODE" ]; then
  [ -n "$prev_online" ] || die "Set ONLINE_MODE=true or ONLINE_MODE=false (must match the world's previous server)."
  ONLINE_MODE="$prev_online"
fi
case "$ONLINE_MODE" in true|false) ;; *) die "ONLINE_MODE must be true or false" ;; esac
if [ -n "$prev_online" ] && [ "$prev_online" != "$ONLINE_MODE" ] && [ "$ALLOW_ONLINE_MODE_CHANGE" != "yes" ]; then
  die "online-mode is $prev_online on this install. Changing it re-keys every player's data. Back up, then re-run with ALLOW_ONLINE_MODE_CHANGE=yes."
fi

# ---------------------------------------------------------------------------
log "Installing base packages and automatic security updates"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl jq ca-certificates gpg iptables iptables-persistent unattended-upgrades
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
log "Installing Java $JAVA_MAJOR"
java_major() { java -version 2>&1 | sed -n 's/.*version "\([0-9]*\).*/\1/p' | head -n1; }
if [ "$(java_major 2>/dev/null || true)" != "$JAVA_MAJOR" ]; then
  if apt-cache show "openjdk-${JAVA_MAJOR}-jre-headless" >/dev/null 2>&1; then
    apt-get install -y "openjdk-${JAVA_MAJOR}-jre-headless"
  else
    warn "Ubuntu has no openjdk-${JAVA_MAJOR} package; using Eclipse Temurin"
    install -d -m 0755 /etc/apt/keyrings
    curl -fsSL https://packages.adoptium.net/artifactory/api/gpg/key/public \
      | gpg --dearmor --yes -o /etc/apt/keyrings/adoptium.gpg
    codename="$(. /etc/os-release && echo "$VERSION_CODENAME")"
    echo "deb [signed-by=/etc/apt/keyrings/adoptium.gpg] https://packages.adoptium.net/artifactory/deb $codename main" \
      > /etc/apt/sources.list.d/adoptium.list
    apt-get update -y
    apt-get install -y "temurin-${JAVA_MAJOR}-jre" || apt-get install -y "temurin-${JAVA_MAJOR}-jdk"
  fi
fi
[ "$(java_major)" = "$JAVA_MAJOR" ] || die "'java' is not Java $JAVA_MAJOR. Check: update-alternatives --config java"
java -version

# ---------------------------------------------------------------------------
log "Opening TCP 25565 in the VM firewall"
# Oracle's Ubuntu images ship iptables rules ending in a REJECT, so ours goes first.
rule=(-p tcp --dport 25565 -m conntrack --ctstate NEW -j ACCEPT)
iptables -C INPUT "${rule[@]}" 2>/dev/null || iptables -I INPUT 1 "${rule[@]}"
netfilter-persistent save

# ---------------------------------------------------------------------------
log "Creating the 'minecraft' system user and directories"
if ! id minecraft >/dev/null 2>&1; then
  useradd --system --home-dir "$MC_HOME" --shell /usr/sbin/nologin --user-group minecraft
fi
install -d -o minecraft -g minecraft -m 0750 "$MC_HOME" "$SERVER_DIR" "$BACKUP_DIR"
if [ -n "$ADMIN_USER" ] && [ "$ADMIN_USER" != "root" ]; then
  usermod -aG minecraft "$ADMIN_USER"
fi

log "Installing helper commands and systemd units"
install -m 0755 "$SCRIPT_DIR/bin/mc-cmd" "$SCRIPT_DIR/bin/mc-console" "$SCRIPT_DIR/bin/mc-backup" \
  "$SCRIPT_DIR/bin/mc-allow" /usr/local/bin/
install -m 0644 "$SCRIPT_DIR/systemd/minecraft.service" "$SCRIPT_DIR/systemd/minecraft.socket" \
  "$SCRIPT_DIR/systemd/minecraft-backup.service" "$SCRIPT_DIR/systemd/minecraft-backup.timer" /etc/systemd/system/
systemctl daemon-reload

# Back up an existing world before changing anything else.
if [ -f "$SERVER_DIR/server.properties" ]; then
  log "Existing install found: taking a pre-setup backup"
  as_mc /usr/local/bin/mc-backup pre-setup
fi

# ---------------------------------------------------------------------------
log "Downloading $SOFTWARE server for Minecraft $MC_VERSION"
cd "$SERVER_DIR"
case "$SOFTWARE" in
  vanilla)
    vurl="$(curl -fsSL https://piston-meta.mojang.com/mc/game/version_manifest_v2.json \
      | jq -r --arg v "$MC_VERSION" '.versions[] | select(.id == $v) | .url')"
    [ -n "$vurl" ] || die "Mojang has no version called $MC_VERSION"
    vjson="$(curl -fsSL "$vurl")"
    fetch "$(jq -r '.downloads.server.url' <<<"$vjson")" server.jar sha1 "$(jq -r '.downloads.server.sha1' <<<"$vjson")"
    ;;

  fabric)
    loader="$(curl -fsSL "https://meta.fabricmc.net/v2/versions/loader/$MC_VERSION" \
      | jq -r '(map(select(.loader.stable)) + .)[0].loader.version // empty')"
    [ -n "$loader" ] || die "Fabric has no loader for $MC_VERSION yet"
    installer="$(curl -fsSL https://meta.fabricmc.net/v2/versions/installer \
      | jq -r '(map(select(.stable)) + .)[0].version // empty')"
    fetch "https://meta.fabricmc.net/v2/versions/loader/$MC_VERSION/$loader/$installer/server/jar" server.jar
    echo "Fabric loader $loader, installer $installer"

    # Server-side mods only. Players never need to install these.
    mods="$FABRIC_MODS"
    [ "$ONLINE_MODE" = "false" ] && mods="$mods easyauth"
    install -d -o minecraft -g minecraft -m 0750 mods
    for slug in $mods; do
      meta="$(curl -fsSL -G -A "$UA" "https://api.modrinth.com/v2/project/$slug/version" \
        --data-urlencode "game_versions=[\"$MC_VERSION\"]" \
        --data-urlencode 'loaders=["fabric"]' 2>/dev/null || echo '[]')"
      # Prefer release builds; fall back to beta/alpha only if nothing else exists.
      file="$(jq -c '(map(select(.version_type == "release")) + .)[0] // empty
                     | {v: .version_number, f: (((.files | map(select(.primary))) + .files)[0])}' <<<"$meta")"
      if [ -z "$file" ]; then
        [ "$slug" = "easyauth" ] && die "No EasyAuth build for $MC_VERSION: refusing to run an offline-mode server without auth."
        warn "No $slug build for $MC_VERSION on Modrinth yet, skipping"
        continue
      fi
      ver="$(jq -r '.v' <<<"$file")"
      rm -f mods/"${slug}"--*.jar
      fetch "$(jq -r '.f.url' <<<"$file")" "mods/${slug}--${ver}.jar" sha512 "$(jq -r '.f.hashes.sha512' <<<"$file")"
      echo "Installed $slug $ver"
    done
    ;;

  paper)
    build="$(curl -fsSL -A "$UA" "https://fill.papermc.io/v3/projects/paper/versions/$MC_VERSION/builds" \
      | jq -c 'first(.[] | select(.channel == "STABLE") | .downloads."server:default") // empty')"
    [ -n "$build" ] || die "No stable Paper build for $MC_VERSION"
    fetch "$(jq -r '.url' <<<"$build")" server.jar sha256 "$(jq -r '.checksums.sha256' <<<"$build")"
    [ "$ONLINE_MODE" = "false" ] && warn "Paper with online-mode=false needs AuthMe (+ FastLogin) plugins, which this script does not install."
    ;;
esac

# ---------------------------------------------------------------------------
log "Writing eula.txt, server.properties and jvm.args"
echo "eula=true" > eula.txt
chown minecraft:minecraft eula.txt
chmod 0640 eula.txt

first_install=false
if [ ! -f server.properties ]; then
  first_install=true
  touch server.properties
  chmod 0640 server.properties
fi

set_prop() {
  if grep -q "^$1=" server.properties; then
    sed -i "s|^$1=.*|$1=$2|" server.properties
  else
    echo "$1=$2" >> server.properties
  fi
}

# Security-relevant settings are enforced on every run.
set_prop online-mode "$ONLINE_MODE"
set_prop white-list true
set_prop enforce-whitelist true
set_prop enable-rcon false
# Offline-mode clients cannot sign chat with a Microsoft profile; EasyAuth needs this off.
if [ "$ONLINE_MODE" = "false" ]; then set_prop enforce-secure-profile false; fi

# Gameplay defaults only on first install, so later changes (e.g. from the dashboard) stick.
if $first_install; then
  set_prop level-name world
  # server.properties overrides the world on startup, so these must match the world's
  # previous server. Vanilla's own default difficulty is "easy", not "normal".
  set_prop difficulty "${DIFFICULTY:-normal}"
  set_prop gamemode "${GAMEMODE:-survival}"
  set_prop hardcore "${HARDCORE:-false}"
  set_prop max-players 10
  set_prop view-distance 10
  set_prop simulation-distance 8
  set_prop motd "Our server"
fi
chown minecraft:minecraft server.properties

# Aikar's G1 flags. Xms = Xmx plus AlwaysPreTouch makes the JVM actually occupy its heap,
# which keeps memory above Oracle's 20% idle-reclaim threshold when nobody is online.
cat > jvm.args <<EOF
-Xms$HEAP
-Xmx$HEAP
-XX:+UseG1GC
-XX:+ParallelRefProcEnabled
-XX:MaxGCPauseMillis=200
-XX:+UnlockExperimentalVMOptions
-XX:+DisableExplicitGC
-XX:+AlwaysPreTouch
-XX:G1NewSizePercent=30
-XX:G1MaxNewSizePercent=40
-XX:G1HeapRegionSize=8M
-XX:G1ReservePercent=20
-XX:G1HeapWastePercent=5
-XX:G1MixedGCCountTarget=4
-XX:InitiatingHeapOccupancyPercent=15
-XX:G1MixedGCLiveThresholdPercent=90
-XX:G1RSetUpdatingPauseTimePercent=5
-XX:SurvivorRatio=32
-XX:+PerfDisableSharedMem
-XX:MaxTenuringThreshold=1
EOF
chown minecraft:minecraft jvm.args
chmod 0640 jvm.args

cat > "$STATE_FILE" <<EOF
software=$SOFTWARE
mc_version=$MC_VERSION
online_mode=$ONLINE_MODE
installed=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
chown minecraft:minecraft "$STATE_FILE"

# ---------------------------------------------------------------------------
log "Enabling services"
systemctl enable minecraft.service
systemctl enable --now minecraft-backup.timer

log "Done. The server is installed but NOT started."
cat <<EOF

Next steps
  1. Put the world in place (skip for a brand-new world):
       sudo tar -xzf world.tar.gz -C $SERVER_DIR   (so you get $SERVER_DIR/world/level.dat)
       sudo chown -R minecraft:minecraft $SERVER_DIR/world
  2. Start:          sudo systemctl start minecraft
  3. Console:        mc-console        (log out and back in once so the minecraft group applies)
EOF
if [ "$ONLINE_MODE" = "false" ]; then
  cat <<EOF
  4. Players (offline mode): use mc-allow, NOT the vanilla whitelist/op commands, which
     look names up with Mojang and store the wrong UUID for any name that is also premium:
       sudo mc-allow Name            (whitelist; names are case-sensitive)
       sudo mc-allow Name --op       (server stopped)
EOF
  [ "$SOFTWARE" = "fabric" ] && cat <<EOF
  5. EasyAuth (config appears after the first start, in $SERVER_DIR/config/EasyAuth/):
       main.conf      premium-auto-login=false   (everyone uses /register + /login)
       extended.conf  forced-offline-uuid=true   (keeps everyone on the offline UUID their
                                                  world data uses)
     then restart.
EOF
else
  cat <<EOF
       whitelist add Name    (each player)
       op Name
EOF
fi
cat <<EOF

Handy commands
  sudo systemctl stop|start|restart minecraft
  systemctl status minecraft
  mc-cmd say hello
  mc-backup                       # manual backup (kept forever)
  ls -lh $BACKUP_DIR
EOF
