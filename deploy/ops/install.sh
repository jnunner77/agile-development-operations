#!/usr/bin/env bash
# Sets up hands-off operations on this server (run it as your normal user; it asks for sudo):
#   - nunner-ops.timer: deploy/ops/nightly.sh every night at 02:30 (OPS_TIME_ZONE), catching
#     up after the VM was off: backups, copies to Cloud Storage, updates, cleanup, checks, alerts
#   - nunner-watch.timer: every 5 minutes (WATCH_MINUTES), updates an app within minutes of a
#     change to its main (nightly.sh --watch); WATCH_MAIN=off turns it off
#   - nunner-reboot.timer: at 04:15, reboots only if security updates need it (before the
#     binder's 05:00 price run; both apps start again on their own)
#   - unattended-upgrades for Debian security updates, journald capped at 200 MB
#   - removes the old crontab backup lines (the nightly job does them now)
# Settings live in ~/.config/nunner-ops.env. Pass them the first time, e.g.
#   BACKUP_BUCKET=my-project-backups HC_PING_KEY=abc123 deploy/ops/install.sh
# Run it again any time (after git pull, or to change a setting); it only changes what differs.
# Undo: deploy/ops/install.sh --remove
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
CONFIG="$HOME/.config/nunner-ops.env"
ME="$(id -un)"
TZ_OPS="${OPS_TIME_ZONE:-America/Vancouver}"

if [ "$(id -u)" = 0 ]; then
  echo "Run this as your normal user (it uses sudo where needed), not as root." >&2
  exit 1
fi

if [ "${1:-}" = --remove ]; then
  sudo systemctl disable --now nunner-ops.timer nunner-watch.timer nunner-reboot.timer 2>/dev/null || true
  sudo rm -f /etc/systemd/system/nunner-{ops,watch,reboot}.{service,timer}
  sudo systemctl daemon-reload
  echo "Removed the timers. Settings are still in $CONFIG; unattended-upgrades stays on."
  echo "Put the nightly backups back in crontab if you want them (deploy/README.md, Day-to-day)."
  exit 0
fi

for cmd in docker git curl openssl flock numfmt systemctl; do
  command -v "$cmd" >/dev/null || { echo "Missing $cmd; install it first." >&2; exit 1; }
done
id -nG | grep -qw docker || { echo "$ME isn't in the docker group (deploy/README.md, step 3)." >&2; exit 1; }

# ---- settings: keep what's there, add what was passed -----------------------------------------
minutes_ok() { [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 30 ]; }
if [ -n "${WATCH_MINUTES:-}" ] && ! minutes_ok "$WATCH_MINUTES"; then
  echo "WATCH_MINUTES must be 1 to 30." >&2
  exit 1
fi
mkdir -p "$(dirname "$CONFIG")"
touch "$CONFIG"
chmod 600 "$CONFIG"
set_value() { # key value: replace or append, only when a value is given
  [ -n "$2" ] || return 0
  if grep -q "^$1=" "$CONFIG"; then sed -i "s|^$1=.*|$1=$2|" "$CONFIG"; else echo "$1=$2" >>"$CONFIG"; fi
}
grep -q '^# nunner-ops' "$CONFIG" || cat >>"$CONFIG" <<'EOF'
# nunner-ops settings (deploy/ops/nightly.sh). Changes take effect on the next run.
# BACKUP_BUCKET   Cloud Storage bucket for copies off the server (empty: no copies)
# HC_PING_KEY     healthchecks.io project ping key (empty: no alerts)
# HC_PREFIX       prefix of the check names on healthchecks.io (default nunner)
# AUTO_UPDATE     on | off: update the apps to their latest main every night
# WATCH_MAIN      on | off: also update an app within minutes of a change to its main
# WATCH_MINUTES   how often to check main, 1-30 minutes (default 5; run install.sh after changing it)
# REFRESH_WEEKDAY 1-7 (Monday-Sunday): also rebuild on fresh base images that day
# BOARDS_DIR, BINDER_DIR, DOMAIN, KEEP_ARCHIVES, DISK_ALERT_PERCENT, OPS_TIME_ZONE
EOF
set_value BACKUP_BUCKET "${BACKUP_BUCKET:-}"
set_value HC_PING_KEY "${HC_PING_KEY:-}"
set_value HC_PREFIX "${HC_PREFIX:-}"
set_value AUTO_UPDATE "${AUTO_UPDATE:-}"
set_value WATCH_MAIN "${WATCH_MAIN:-}"
set_value WATCH_MINUTES "${WATCH_MINUTES:-}"
set_value OPS_TIME_ZONE "${OPS_TIME_ZONE:-}"
echo "Settings in $CONFIG:"
grep -v '^#' "$CONFIG" | sed -e 's/^\(HC_PING_KEY=\).*\(....\)$/\1****\2/' -e 's/^/  /'

# ---- systemd units ----------------------------------------------------------------------------
setting() { sed -n "s/^$1=//p" "$CONFIG" | tail -1; }
WATCH_ON=$(setting WATCH_MAIN); WATCH_ON=${WATCH_ON:-on}
WATCH_EVERY=$(setting WATCH_MINUTES); WATCH_EVERY=${WATCH_EVERY:-5}
if ! minutes_ok "$WATCH_EVERY"; then
  echo "WATCH_MINUTES must be 1 to 30 (it's $WATCH_EVERY in $CONFIG)." >&2
  exit 1
fi
write_file() { # path content: write only when it differs; true when it changed
  if cmp -s <(printf '%s\n' "$2") "$1" 2>/dev/null; then return 1; fi
  if ! { sudo mkdir -p "$(dirname "$1")" && printf '%s\n' "$2" | sudo tee "$1" >/dev/null; }; then
    echo "Couldn't write $1" >&2
    exit 1
  fi
  echo "Wrote $1"
}
unit() { write_file "/etc/systemd/system/$1" "$2" || true; }
unit nunner-ops.service "[Unit]
Description=Nightly operations: backups, copies off the server, updates, checks (deploy/ops/nightly.sh)
Wants=network-online.target
After=network-online.target docker.service

[Service]
Type=oneshot
User=$ME
SupplementaryGroups=docker
Environment=HOME=$HOME
WorkingDirectory=$HOME
ExecStart=$REPO/deploy/ops/nightly.sh
Nice=10
IOSchedulingClass=idle
TimeoutStartSec=2h"
unit nunner-ops.timer "[Unit]
Description=Run nunner-ops every night

[Timer]
OnCalendar=*-*-* 02:30:00 $TZ_OPS
RandomizedDelaySec=10min
Persistent=true

[Install]
WantedBy=timers.target"
unit nunner-watch.service "[Unit]
Description=Update an app soon after its main changes on GitHub (deploy/ops/nightly.sh --watch)
Wants=network-online.target
After=network-online.target docker.service

[Service]
Type=oneshot
User=$ME
SupplementaryGroups=docker
Environment=HOME=$HOME
WorkingDirectory=$HOME
ExecStart=$REPO/deploy/ops/nightly.sh --watch
Nice=10
IOSchedulingClass=idle
TimeoutStartSec=1h"
unit nunner-watch.timer "[Unit]
Description=Check main on GitHub every $WATCH_EVERY minutes

[Timer]
OnCalendar=*:0/$WATCH_EVERY
RandomizedDelaySec=30s

[Install]
WantedBy=timers.target"
unit nunner-reboot.service "[Unit]
Description=Reboot if security updates need it, unless nunner-ops is running

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'if [ -f /run/reboot-required ] && ! systemctl is-active --quiet nunner-ops.service nunner-watch.service; then systemctl reboot; fi'"
unit nunner-reboot.timer "[Unit]
Description=Reboot window for security updates

[Timer]
OnCalendar=*-*-* 04:15:00 $TZ_OPS

[Install]
WantedBy=timers.target"
sudo systemctl daemon-reload
sudo systemctl enable --now nunner-ops.timer nunner-reboot.timer >/dev/null
if [ "$WATCH_ON" = on ]; then
  sudo systemctl enable --now nunner-watch.timer >/dev/null
  sudo systemctl restart nunner-watch.timer # picks up a changed WATCH_MINUTES
else
  sudo systemctl disable --now nunner-watch.timer >/dev/null 2>&1 || true
  echo "Watching main is off (WATCH_MAIN=off); updates happen in the nightly run only."
fi

# ---- operating system ---------------------------------------------------------------------------
if ! dpkg -s unattended-upgrades >/dev/null 2>&1; then
  sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unattended-upgrades >/dev/null
fi
echo 'unattended-upgrades unattended-upgrades/enable_auto_updates boolean true' | sudo debconf-set-selections
sudo dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1
write_file /etc/apt/apt.conf.d/52nunner-ops '// nunner-ops: reboots happen in the 04:15 window (nunner-reboot.timer), not at random.
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
APT::Periodic::AutocleanInterval "7";' || true
if write_file /etc/systemd/journald.conf.d/nunner-ops.conf $'[Journal]\nSystemMaxUse=200M'; then
  sudo systemctl restart systemd-journald
fi

# ---- crontab: the nightly job does the backups now; keep everything else (DuckDNS) ------------
current_crontab=$(crontab -l 2>/dev/null || true)
if grep -q 'deploy/backup.sh' <<<"$current_crontab"; then
  grep -v 'deploy/backup.sh' <<<"$current_crontab" | crontab -
  echo "Removed the old backup lines from crontab (nunner-ops does them):"
  crontab -l 2>/dev/null | sed 's/^/  /'
fi

echo
systemctl list-timers --no-pager 'nunner-*'
echo
[ "$WATCH_ON" = on ] && echo "Watching main: a merge goes live within about $WATCH_EVERY minutes plus the build (nunner-watch)."
echo "Installed. Try a run now (takes a few minutes):"
echo "  sudo systemctl start nunner-ops; cat ~/.local/state/nunner-ops/last-report.txt"
