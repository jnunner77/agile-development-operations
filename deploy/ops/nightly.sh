#!/usr/bin/env bash
# Nightly operations for Boards and the apps next to it on this server. In order:
#   1. back up each app's data to ~/<app>-backups (deploy/backup.sh in each repository)
#   2. copy the new archives to a Cloud Storage bucket (BACKUP_BUCKET), off this disk
#   3. update each app to its latest main, but only when it changed (once a week also refresh
#      base images); a new version that doesn't come up healthy is rolled back
#   4. clean up old Docker images and build cache so the 30 GB disk doesn't fill
#   5. check both sites over HTTPS, certificates, disk, swap and the binder's own checks
#   6. report to healthchecks.io (HC_PING_KEY), which emails when something needs you
# Installed by deploy/ops/install.sh as the nunner-ops timer. Run it by hand any time:
#   sudo systemctl start nunner-ops        # or: deploy/ops/nightly.sh
# Last report: cat ~/.local/state/nunner-ops/last-report.txt; history: journalctl -u nunner-ops
#
# With --watch (the nunner-watch timer, every few minutes) it only does step 3, and only for the
# apps whose main changed on GitHub, so a merged pull request goes live within minutes. Checking
# costs one git ls-remote per app; when nothing changed it prints nothing and exits. A commit that
# failed to build or was rolled back isn't tried again until main moves on (the nightly run still
# retries it). Last report: ~/.local/state/nunner-ops/last-watch.txt; journalctl -u nunner-watch
#
# Everything runs one step at a time, niced, with nothing in the background: the e2-micro has
# 1 GB of memory and a fraction of a CPU, and both apps keep serving while this runs.
set -uo pipefail

CONFIG="${NUNNER_OPS_CONFIG:-$HOME/.config/nunner-ops.env}"
STATE="${NUNNER_OPS_STATE:-$HOME/.local/state/nunner-ops}"

PROBLEMS=() # something is broken: the "nightly" check fails
ATTENTION=() # something needs a person (e.g. a card to match): the "attention" check fails
UPDATE_PROBLEMS=() # an update failed or was rolled back: the "updates" check fails
UPDATES=()
DONE=()

problem() { PROBLEMS+=("$*"); echo "PROBLEM: $*"; }
attention() { ATTENTION+=("$*"); echo "NEEDS YOU: $*"; }
done_() { DONE+=("$*"); echo "ok: $*"; }

# Value of KEY in an env file, without sourcing it.
env_value() { [ -f "$1" ] && sed -n "s/^$2=//p" "$1" | tail -1 | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }

human() { numfmt --to=iec --suffix=B "$1" 2>/dev/null || echo "$1 bytes"; }

# ---- apps ------------------------------------------------------------------------------------
# name|repository folder|compose service|public address. Loops go over the APPS array rather
# than reading a pipe, because docker compose exec would swallow the rest of the list from stdin.
apps() {
  echo "boards|$BOARDS_DIR|app|$DOMAIN"
  if [ -d "$BINDER_DIR/.git" ]; then echo "binder|$BINDER_DIR|binder|binder.$DOMAIN"; fi
}

container_state() { # dir service -> healthy | unhealthy | starting | running | missing
  local id
  id=$(cd "$1" && docker compose ps -q "$2" 2>/dev/null)
  [ -n "$id" ] || { echo missing; return; }
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo missing
}

wait_healthy() { # dir service seconds
  local deadline=$((SECONDS + $3)) s
  while [ $SECONDS -lt $deadline ]; do
    s=$(container_state "$1" "$2")
    case "$s" in healthy) return 0 ;; unhealthy) return 1 ;; esac
    sleep 5
  done
  [ "$(container_state "$1" "$2")" = healthy ] || [ "$(container_state "$1" "$2")" = running ]
}

site_ok() { curl -fsS -m 20 -o /dev/null "https://$1/api/health"; }

# ---- 1. backups ------------------------------------------------------------------------------
backup_app() { # name dir
  local out file
  if ! out=$(cd "$2" && KEEP="${KEEP_ARCHIVES:-14}" deploy/backup.sh 2>&1); then
    problem "$1: the nightly backup failed: $(echo "$out" | tail -2 | tr '\n' ' ')"
    return
  fi
  file=$(ls -1t "$HOME/$1-backups/$1"-*.tar.gz 2>/dev/null | head -1)
  if [ -z "$file" ] || ! gzip -t "$file" 2>/dev/null; then
    problem "$1: the newest backup archive is missing or damaged ($file)"
    return
  fi
  NEWEST[$1]="$file"
  done_ "$1: backed up to $file ($(human "$(stat -c %s "$file")"))"
}

# ---- 2. copy off the server ------------------------------------------------------------------
gcs_token() {
  curl -fsS -m 10 -H 'Metadata-Flavor: Google' \
    "${METADATA_URL:-http://metadata.google.internal}/computeMetadata/v1/instance/service-accounts/default/token" |
    sed -n 's/.*"access_token" *: *"\([^"]*\)".*/\1/p'
}

offsite_app() { # name dir
  local file="${NEWEST[$1]:-}" token object resp size at
  [ -n "$file" ] || return 0
  if ! token=$(gcs_token) || [ -z "$token" ]; then
    problem "$1: couldn't get Cloud Storage access from the VM's service account (see deploy/README.md, Automatic operations)"
    return
  fi
  object="$1/$(basename "$file")"
  # Streamed upload (-T) so a large archive never sits in memory; ifGenerationMatch=0 never overwrites.
  if ! resp=$(curl -fsS -m 1800 -X POST -T "$file" -H "Authorization: Bearer $token" -H 'Content-Type: application/gzip' \
    "${GCS_URL:-https://storage.googleapis.com}/upload/storage/v1/b/$BACKUP_BUCKET/o?uploadType=media&ifGenerationMatch=0&name=${object//\//%2F}" 2>&1); then
    problem "$1: copying the backup to gs://$BACKUP_BUCKET failed: $(echo "$resp" | tail -1)"
    return
  fi
  size=$(echo "$resp" | sed -n 's/.*"size" *: *"\([0-9]*\)".*/\1/p' | head -1)
  if [ "$size" != "$(stat -c %s "$file")" ]; then
    problem "$1: Cloud Storage has a different size for gs://$BACKUP_BUCKET/$object ($size bytes)"
    return
  fi
  done_ "$1: copied to gs://$BACKUP_BUCKET/$object"
  at=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  # Tell the binder, so its Overview counts the copy (status.ts, offsite.json).
  if [ "$1" = binder ]; then
    printf '{"at":"%s","where":"gs://%s/%s"}\n' "$at" "$BACKUP_BUCKET" "$object" |
      (cd "$2" && docker compose exec -T binder sh -c 'cat > /data/offsite.json.tmp && mv /data/offsite.json.tmp /data/offsite.json') ||
      problem "binder: couldn't record the off-site copy in the app"
    OFFSITE_MARKED="$at"
  fi
}

# ---- 3. updates ------------------------------------------------------------------------------
free_mb() { awk '/^(MemAvailable|SwapFree):/ {s += $2} END {print int(s / 1024)}' /proc/meminfo; }
disk_free_mb() { df -Pm / | awk 'NR == 2 {print $4}'; }

# A commit of main that couldn't be put live: kept in $STATE/failed-<app> so the watch doesn't
# retry it every few minutes. Cleared once main is live.
failed_sha() { cat "$STATE/failed-$1" 2>/dev/null; }
update_problem() { # name sha message
  UPDATE_PROBLEMS+=("$3")
  [ -n "$2" ] && echo "$2" >"$STATE/failed-$1"
}

update_app() { # name dir service host
  local name=$1 dir=$2 service=$3 host=$4 old new refresh=0 id image repo log
  cd "$dir" || return
  if ! git fetch -q origin main 2>/dev/null; then
    # The watch tries again in a few minutes; the nightly run reports it.
    if [ "$WATCH" = 1 ]; then echo "$name: couldn't fetch from GitHub; trying again next time"
    else UPDATE_PROBLEMS+=("$name: couldn't fetch from GitHub; not updated"); fi
    return
  fi
  old=$(git rev-parse HEAD)
  new=$(git rev-parse origin/main)
  [ "$WATCH" = 0 ] && [ "$(date +%u)" = "${REFRESH_WEEKDAY:-7}" ] && refresh=1
  if [ "$old" = "$new" ] && [ $refresh = 0 ]; then
    rm -f "$STATE/failed-$name"
    UPDATES+=("$name: up to date (${old:0:7})")
    return
  fi
  if [ "$(git rev-parse --abbrev-ref HEAD)" != main ] || [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    update_problem "$name" "$new" "$name: $dir isn't a clean checkout of main (git status), so it isn't updated automatically"
    return
  fi
  if ! git merge-base --is-ancestor "$old" "$new"; then
    update_problem "$name" "$new" "$name: main on GitHub doesn't follow on from ${old:0:7}; update it by hand"
    return
  fi
  if [ "$(free_mb)" -lt "${MIN_FREE_MB:-600}" ] || [ "$(disk_free_mb)" -lt 2048 ]; then
    if [ "$WATCH" = 1 ]; then echo "$name: not enough free memory ($(free_mb) MB) or disk ($(disk_free_mb) MB) to build ${new:0:7}; trying again next time"
    else UPDATE_PROBLEMS+=("$name: not enough free memory ($(free_mb) MB) or disk ($(disk_free_mb) MB) to build; will try tomorrow"); fi
    return
  fi
  ATTEMPTED=1

  # Keep the running image so a bad update can be undone without rebuilding.
  id=$(docker compose ps -q "$service")
  image=$(docker inspect -f '{{.Config.Image}}' "$id" 2>/dev/null)
  repo=${image%:*}
  [ -n "$image" ] && docker image tag "$image" "$repo:rollback"

  log="$STATE/build-$name.log"
  git merge -q --ff-only origin/main
  echo "$name: building ${new:0:7}$([ $refresh = 1 ] && echo ' with fresh base images')…"
  local pull=()
  [ $refresh = 1 ] && pull=(--pull)
  if ! nice -n 10 docker compose build "${pull[@]}" "$service" >"$log" 2>&1; then
    git reset -q --hard "$old"
    update_problem "$name" "$new" "$name: building ${new:0:7} failed, so the old version keeps running. Last lines: $(tail -3 "$log" | tr '\n' ' ')"
    return
  fi
  [ $refresh = 1 ] && [ "$name" = boards ] && docker compose pull -q caddy >/dev/null 2>&1
  docker compose up -d >>"$log" 2>&1
  if wait_healthy "$dir" "$service" 240 && sleep 5 && site_ok "$host"; then
    # A changed Caddyfile only takes effect once Caddy reloads it.
    if [ "$name" = boards ] && ! git diff --quiet "$old" "$new" -- deploy/Caddyfile; then
      docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile >>"$log" 2>&1 || docker compose restart caddy >>"$log" 2>&1
    fi
    rm -f "$STATE/failed-$name"
    if [ "$old" = "$new" ]; then UPDATES+=("$name: base images refreshed (${new:0:7}), healthy")
    else UPDATES+=("$name: updated ${old:0:7} → ${new:0:7} ($(git log --format=%s -1 "$new")), healthy"); fi
    return
  fi
  # Not healthy: back to the previous code and image.
  git reset -q --hard "$old"
  [ -n "$image" ] && docker image tag "$repo:rollback" "$image"
  docker compose up -d >>"$log" 2>&1
  if wait_healthy "$dir" "$service" 180; then
    update_problem "$name" "$new" "$name: ${new:0:7} didn't come up healthy, so it was rolled back to ${old:0:7}. Build and start log: $log"
  else
    echo "$new" >"$STATE/failed-$name"
    problem "$name: ${new:0:7} didn't come up healthy and the rollback to ${old:0:7} isn't healthy either. Log: $log"
  fi
}

# ---- 4. cleanup ------------------------------------------------------------------------------
cleanup() {
  local before after
  before=$(df -PB1 / | awk 'NR == 2 {print $3}')
  docker image prune -f >/dev/null 2>&1
  docker builder prune -f --filter until=168h >/dev/null 2>&1
  find "$STATE" -name 'build-*.log' -mtime +30 -delete 2>/dev/null
  after=$(df -PB1 / | awk 'NR == 2 {print $3}')
  [ "$before" -gt "$after" ] && done_ "cleanup: freed $(human $((before - after))) (old images, build cache)"
}

# ---- 5. checks -------------------------------------------------------------------------------
cert_days() { # host -> days until its certificate expires
  local end
  end=$(echo | timeout 15 openssl s_client -servername "$1" -connect "$1:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
  [ -n "$end" ] && echo $((($(date -d "$end" +%s) - $(date +%s)) / 86400))
}

binder_status() { # dir
  local text written since="${OFFSITE_MARKED:-}" deadline=$((SECONDS + 400))
  text=$(cd "$1" && docker compose exec -T binder cat /data/status.txt 2>/dev/null) || {
    problem "binder: no status file yet (it arrives with the binder update that adds status.txt)"
    return
  }
  # After recording an off-site copy, wait for the app's next status (every 5 minutes) to include it.
  while [ -n "$since" ] && [[ "$(echo "$text" | sed -n 's/^written //p')" < "$since" ]] && [ $SECONDS -lt $deadline ]; do
    sleep 20
    text=$(cd "$1" && docker compose exec -T binder cat /data/status.txt 2>/dev/null)
  done
  written=$(echo "$text" | sed -n 's/^written //p')
  if [ -z "$written" ] || [ $(($(date +%s) - $(date -d "$written" +%s 2>/dev/null || echo 0))) -gt 3600 ]; then
    problem "binder: its status file is stale (written ${written:-never}); the app may be stuck"
  fi
  while IFS= read -r line; do
    case "$line" in
    "fail "*) problem "binder: ${line#fail }" ;;
    "warn "* | "attention "*) attention "binder: ${line#* }" ;;
    esac
  done <<<"$text"
}

checks() {
  local name dir service host days used app
  for app in "${APPS[@]}"; do
    IFS='|' read -r name dir service host <<<"$app"
    [ "$(container_state "$dir" "$service")" = healthy ] || problem "$name: the container is $(container_state "$dir" "$service")"
    if site_ok "$host"; then done_ "$name: https://$host answers"; else problem "$name: https://$host/api/health doesn't answer"; fi
    days=$(cert_days "$host")
    if [ -z "$days" ]; then problem "$name: couldn't read the HTTPS certificate of $host"
    elif [ "$days" -lt 14 ]; then problem "$name: the certificate for $host expires in $days days (Caddy renews at 30; check docker compose logs caddy)"; fi
  done
  [ -d "$BINDER_DIR/.git" ] && binder_status "$BINDER_DIR" </dev/null

  used=$(df -P / | awk 'NR == 2 {print int($5)}')
  if [ "$used" -ge "${DISK_ALERT_PERCENT:-85}" ]; then problem "disk: $used% used ($(disk_free_mb) MB free)"
  else done_ "disk: $used% used, $(disk_free_mb) MB free"; fi
  [ -n "$(swapon --noheadings --show 2>/dev/null)" ] || problem "memory: no swap; builds will fail on 1 GB (deploy/README.md, step 3)"
  [ -f /run/reboot-required ] && done_ "system: security updates are waiting for the reboot window"
}

# ---- 6. report -------------------------------------------------------------------------------
section() { # title items...
  local t=$1
  shift
  [ $# -gt 0 ] || return 0
  printf '\n%s\n' "$t"
  printf -- '- %s\n' "$@"
}

ping_hc() { # check-name ok|fail body
  [ -n "${HC_PING_KEY:-}" ] || return 0
  local url="${HC_URL:-https://hc-ping.com}/$HC_PING_KEY/${HC_PREFIX:-nunner}-$1"
  [ "$2" = ok ] || url="$url/fail"
  curl -fsS -m 15 --retry 3 -o /dev/null --data-binary "$3" "$url?create=1" || echo "couldn't reach healthchecks.io"
}

# ---- watch: update the apps whose main changed, within minutes of a merge --------------------
watch_main() {
  local name dir service host app remote changed=() started=$SECONDS report
  [ "${AUTO_UPDATE:-on}" = on ] && [ "${WATCH_MAIN:-on}" = on ] && [ -n "$DOMAIN" ] || return 0
  for app in "${APPS[@]}"; do
    IFS='|' read -r name dir service host <<<"$app"
    remote=$(timeout 60 git -C "$dir" ls-remote origin refs/heads/main 2>/dev/null | cut -f1)
    [ -n "$remote" ] || continue # GitHub didn't answer: try again next time
    [ "$remote" = "$(git -C "$dir" rev-parse HEAD 2>/dev/null)" ] && continue
    [ "$remote" = "$(failed_sha "$name")" ] && continue # tried already; waits for a newer main or the nightly run
    changed+=("$app")
  done
  [ ${#changed[@]} -gt 0 ] || return 0

  ATTEMPTED=0
  for app in "${changed[@]}"; do IFS='|' read -r name dir service host <<<"$app"; update_app "$name" "$dir" "$service" "$host" </dev/null; done
  cd "$HOME" || true
  [ "$ATTEMPTED" = 1 ] || [ ${#UPDATE_PROBLEMS[@]} -gt 0 ] || [ ${#PROBLEMS[@]} -gt 0 ] || return 0
  # An app still held back by an earlier failure keeps the updates check down.
  for app in "${APPS[@]}"; do
    IFS='|' read -r name dir service host <<<"$app"
    [ -n "$(failed_sha "$name")" ] && ! printf '%s\n' "${UPDATE_PROBLEMS[@]}" "${PROBLEMS[@]}" | grep -q "^$name: " &&
      UPDATE_PROBLEMS+=("$name: still on $(git -C "$dir" rev-parse --short HEAD); main $(failed_sha "$name" | cut -c1-7) couldn't be put live, and the nightly run tries it again (the report from that try says why)")
  done

  report=$(
    echo "nunner-watch on $(hostname), $(TZ="${OPS_TIME_ZONE:-America/Vancouver}" date '+%Y-%m-%d %H:%M %Z'), took $(((SECONDS - started) / 60)) min $(((SECONDS - started) % 60)) s"
    section "PROBLEMS" "${PROBLEMS[@]}"
    section "UPDATE PROBLEMS" "${UPDATE_PROBLEMS[@]}"
    section "UPDATES" "${UPDATES[@]}"
  )
  echo "$report" >"$STATE/last-watch.txt"
  printf '\n%s\n' "$report"
  # A site left down (the rollback didn't come up either) can't wait for the night.
  [ ${#PROBLEMS[@]} -eq 0 ] || ping_hc nightly fail "$report"
  ping_hc updates "$([ ${#UPDATE_PROBLEMS[@]} -eq 0 ] && echo ok || echo fail)" "$report"
  [ ${#PROBLEMS[@]} -eq 0 ] && [ ${#UPDATE_PROBLEMS[@]} -eq 0 ]
}

main() {
  WATCH=0
  [ "${1:-}" = --watch ] && WATCH=1
  mkdir -p "$STATE"
  exec 9>"$STATE/lock"
  if [ "$WATCH" = 1 ]; then
    flock -n 9 || exit 0 # the nightly run (or a manual one) is going; it updates too
  elif ! flock -n 9; then
    # Usually the watch building an update: wait for it rather than skip the night's backups.
    echo "Another run is in progress; waiting for it to finish…"
    flock -w 6600 9 || { echo "Still busy after 110 minutes; giving up."; exit 1; }
  fi
  # shellcheck source=/dev/null
  [ -f "$CONFIG" ] && . "$CONFIG"
  BOARDS_DIR="${BOARDS_DIR:-$HOME/agile-development-operations}"
  BINDER_DIR="${BINDER_DIR:-$HOME/pokemon-card-organizer}"
  DOMAIN="${DOMAIN:-$(env_value "$BOARDS_DIR/.env" DOMAIN)}"
  BACKUP_BUCKET="${BACKUP_BUCKET:-}"
  declare -gA NEWEST=()
  OFFSITE_MARKED=""
  mapfile -t APPS < <(apps)
  if [ "$WATCH" = 1 ]; then
    watch_main
    return
  fi
  local started=$SECONDS name dir service host app

  if [ -z "$DOMAIN" ]; then
    problem "setup: DOMAIN isn't set in $BOARDS_DIR/.env or $CONFIG"
  else
    for app in "${APPS[@]}"; do IFS='|' read -r name dir service host <<<"$app"; backup_app "$name" "$dir" </dev/null; done
    if [ -n "$BACKUP_BUCKET" ]; then
      for app in "${APPS[@]}"; do IFS='|' read -r name dir service host <<<"$app"; offsite_app "$name" "$dir"; done
    else
      attention "backups: nothing is copied off this server yet; set BACKUP_BUCKET (deploy/README.md, Automatic operations)"
    fi
    if [ "${AUTO_UPDATE:-on}" = on ]; then
      for app in "${APPS[@]}"; do IFS='|' read -r name dir service host <<<"$app"; update_app "$name" "$dir" "$service" "$host" </dev/null; done
      cd "$HOME" || true
    else
      UPDATES+=("automatic updates are off (AUTO_UPDATE=off)")
    fi
    cleanup
    checks
  fi

  local report
  report=$(
    echo "nunner-ops on $(hostname), $(TZ="${OPS_TIME_ZONE:-America/Vancouver}" date '+%Y-%m-%d %H:%M %Z'), took $(((SECONDS - started) / 60)) min $(((SECONDS - started) % 60)) s"
    section "PROBLEMS" "${PROBLEMS[@]}"
    section "NEEDS YOU" "${ATTENTION[@]}"
    section "UPDATE PROBLEMS" "${UPDATE_PROBLEMS[@]}"
    section "UPDATES" "${UPDATES[@]}"
    section "DONE" "${DONE[@]}"
  )
  echo "$report" >"$STATE/last-report.txt"
  printf '\n%s\n' "$report"

  ping_hc nightly "$([ ${#PROBLEMS[@]} -eq 0 ] && echo ok || echo fail)" "$report"
  ping_hc attention "$([ ${#ATTENTION[@]} -eq 0 ] && echo ok || echo fail)" "$report"
  ping_hc updates "$([ ${#UPDATE_PROBLEMS[@]} -eq 0 ] && echo ok || echo fail)" "$report"
  [ ${#PROBLEMS[@]} -eq 0 ] && [ ${#UPDATE_PROBLEMS[@]} -eq 0 ]
}

# Everything is in functions and runs from here, so updating this repository mid-run (step 3)
# can't change the script under the running shell.
main "$@"
exit $?
