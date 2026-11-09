#!/usr/bin/env bash
# Tests bin/mc-backup's skip rule and housekeeping with the server "stopped" (test/fakebin/systemctl).
# Run: bash test/mc-backup.test.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SUT="${1:-$HERE/../bin/mc-backup}"
W="$(mktemp -d)"
chmod +x "$HERE"/fakebin/* 2>/dev/null || true
export PATH="$HERE/fakebin:$PATH"
export MC_SERVER_DIR="$W/server" MC_BACKUP_DIR="$W/backups" MC_TRASH_DIR="$W/trash"
B="$MC_BACKUP_DIR"
mkdir -p "$MC_SERVER_DIR/world/players/data" "$B" "$MC_TRASH_DIR"
echo "level-name=world" > "$MC_SERVER_DIR/server.properties"
echo level > "$MC_SERVER_DIR/world/level.dat"
pass=0; fail=0
ok() { if eval "$2"; then pass=$((pass+1)); echo "ok   - $1"; else fail=$((fail+1)); echo "FAIL - $1"; fi; }
count() { ls "$B" | grep -c -- "$1" || true; }
stamp() { date -u -d "$1" +%Y%m%d-%H%M%SZ; }
fake() { : > "$B/world-$(stamp "$1")-$2.tar.gz"; touch -d "$1" "$B/world-$(stamp "$1")-$2.tar.gz"; }

out="$(bash "$SUT" 'bad tag!' 2>&1)"; rc=$?
ok "rejects odd tags" '[ $rc -eq 2 ]'

out="$(bash "$SUT" auto 2>&1)"; rc=$?
ok "first auto backup is made (no players yet)" '[ $rc -eq 0 ] && [ "$(count auto)" -eq 1 ]'
ok "archive holds the world and settings" 'tar -tzf "$B"/*-auto.tar.gz | grep -qx world/level.dat && tar -tzf "$B"/*-auto.tar.gz | grep -qx server.properties'

echo p1 > "$MC_SERVER_DIR/world/players/data/p1.dat"; touch -d "2 hours ago" "$MC_SERVER_DIR/world/players/data/p1.dat"
out="$(bash "$SUT" auto 2>&1)"; rc=$?
ok "idle server: auto backup skipped" '[ $rc -eq 0 ] && [[ "$out" == *skipping* ]] && [ "$(count auto)" -eq 1 ]'
out="$(bash "$SUT" 2>&1)"; rc=$?
ok "manual backup is never skipped" '[ $rc -eq 0 ] && [ "$(count manual)" -eq 1 ]'

sleep 1.1; touch "$MC_SERVER_DIR/world/players/data/p1.dat"; sleep 1.1
out="$(bash "$SUT" auto 2>&1)"; rc=$?
ok "someone played: auto backup made" '[ $rc -eq 0 ] && [ "$(count auto)" -eq 2 ]'

sleep 1.1; touch -d "8 days ago" "$B"/*-auto.tar.gz; touch -d "9 days ago" "$MC_SERVER_DIR/world/players/data/p1.dat"
out="$(bash "$SUT" auto 2>&1)"; rc=$?
ok "idle but last backup over a week old: backup made" '[ $rc -eq 0 ] && [ "$(count auto)" -eq 3 ]'

# Retention: 4 a day for 20 days, then one run with KEEP_RECENT=6 KEEP_DAILY=10.
rm -f "$B"/*-auto.tar.gz
for d in $(seq 1 20); do for h in 00 06 12 18; do fake "$d days ago $h:00" auto; done; done
touch "$MC_SERVER_DIR/world/players/data/p1.dat"
newest_before="$(ls "$B" | grep auto | sort | tail -1)"
out="$(KEEP_RECENT=6 KEEP_DAILY=10 bash "$SUT" auto 2>&1)"; rc=$?
kept="$(ls "$B" | grep auto | sort -r)"
ok "retention: run succeeds" '[ $rc -eq 0 ]'
ok "retention: 6 recent + 10 dailies kept" '[ "$(echo "$kept" | wc -l)" -eq 16 ]'
ok "retention: the 6 newest all survive" '[ "$(echo "$kept" | sed -n 6p)" = "$(ls "$B" | grep auto | sort -r | sed -n 6p)" ] && echo "$kept" | grep -qx "$newest_before"'
ok "retention: older days keep one each, the last of the day" '[ "$(echo "$kept" | tail -n 10 | grep -c -- "-180000Z-")" -eq 10 ] && [ "$(echo "$kept" | tail -n 10 | cut -c7-14 | sort -u | wc -l)" -eq 10 ]'
ok "retention: manual backup untouched" '[ "$(count manual)" -eq 1 ]'

# Safety copies and trash.
fake "40 days ago" hopon_prereset; fake "5 days ago" hopon_predelete; fake "400 days ago" pre-migrate; fake "400 days ago" hopon_manual
: > "$B/world-x.tar.gz.partial"; touch -d "3 days ago" "$B/world-x.tar.gz.partial"
T3="$(stamp '3 days ago')"
mkdir -p "$MC_TRASH_DIR/hopon-$(stamp '20 days ago')" "$MC_TRASH_DIR/hopon-reset-$T3-a1b2c3" "$MC_TRASH_DIR/keepme"
echo x > "$MC_TRASH_DIR/w1-mod-foo.jar-$(stamp '30 days ago')-ffeedd"
touch -d "400 days ago" "$MC_TRASH_DIR/hopon-reset-$T3-a1b2c3"
touch "$MC_SERVER_DIR/world/players/data/p1.dat"
out="$(bash "$SUT" auto 2>&1)"; rc=$?
ok "old safety copy removed, recent one kept" '[ $rc -eq 0 ] && [ "$(count _prereset)" -eq 0 ] && [ "$(count _predelete)" -eq 1 ]'
ok "pre-migrate and world manual backups kept forever" '[ "$(count pre-migrate)" -eq 1 ] && [ "$(count hopon_manual)" -eq 1 ]'
ok "stale partial file removed" '[ "$(count partial)" -eq 0 ]'
ok "trash: old items emptied by the date in their name" '[ "$(ls "$MC_TRASH_DIR" | tr "\n" " ")" = "hopon-reset-$T3-a1b2c3 keepme " ]'

out="$(KEEP_RECENT=0 bash "$SUT" auto 2>&1)"; rc=$?
ok "KEEP_RECENT=0 rejected" '[ $rc -eq 2 ]'

rm -rf "$W"
echo "passed $pass, failed $fail"
[ "$fail" -eq 0 ]
