# Hands-off operations

Once this is set up, the server looks after itself. Every night at 02:30 (Vancouver time) the
`nunner-ops` job (`deploy/ops/nightly.sh`):

1. **Backs up** Boards and the binder to `~/boards-backups` and `~/binder-backups` (newest 14 kept).
2. **Copies both archives to Cloud Storage**, off the VM's disk. The bucket deletes copies after
   35 days. The VM can add copies but can't delete them, so a compromised server can't wipe its backups.
3. **Updates both apps** when `main` has changed on GitHub. A new version that doesn't come up
   healthy is **rolled back** automatically. On Sundays it also rebuilds on fresh base images
   (security fixes in Node and Debian). Between nightly runs, **`nunner-watch`** checks `main`
   every 5 minutes, so a merged pull request goes live within about 15 minutes
   ([Watching main](#watching-main)).
4. **Cleans up** old Docker images and build cache, so the 30 GB disk doesn't fill.
5. **Checks** both sites over HTTPS, their certificates, disk, swap, and the binder's own
   Overview checks, including cards that need a match.
6. **Reports** to [healthchecks.io](https://healthchecks.io), which **emails you** only when
   something changes.

Also set up:

- **Debian security updates** install on their own (unattended-upgrades).
- **Reboots** for kernel updates happen only at 04:15, and only when one is needed. Both apps
  start again on their own before the binder's 05:00 price run.
- The system journal is capped at 200 MB.

You get three checks on healthchecks.io. Each emails you when it goes **down**, and again when it
is back **up**:

| Check | Goes down when | What to do |
| --- | --- | --- |
| `nunner-nightly` | Something is broken: a backup or copy failed, a site doesn't answer, a certificate is expiring, the disk is 85% full. Also when the job doesn't report at all (VM off or stuck). | Read the report (below). |
| `nunner-attention` | Something needs a person: cards that need a match or have no price, a binder Overview warning. | Do what it says, usually in the binder. It comes back up the night after. |
| `nunner-updates` | An update didn't build, or didn't come up healthy and was rolled back. The old version keeps running. | Nothing urgent. Tell Claude what the report says; it retries every night until a fixed version is merged. |

**The report:** each check on healthchecks.io shows the night's full report under its last
ping. On the VM it's in `~/.local/state/nunner-ops/last-report.txt`, with history in
`journalctl -u nunner-ops`.

**Staying inside the free tier:**
- **Memory (1 GB):** one step at a time, at low CPU and disk priority. A build only starts when
  at least 600 MB of memory plus swap is free; otherwise it waits a day.
- **CPU:** builds happen only when the code changed, plus once on Sundays.
- **Disk (30 GB):** old images and build cache are pruned nightly, 14 archives per app are
  kept, and the journal is capped. You're alerted at 85% full.
- **Cloud Storage:** 5 GB is free in us-central1. 35 days of copies is about 0.5 GB, and about
  60 uploads a month is well under the 5,000 free operations. VM to bucket in the same region
  costs no network.
- **Network (1 GB out a month):** the copies to Cloud Storage don't count. Pings to
  healthchecks.io are a few KB a night.
- **healthchecks.io:** the free plan has 20 checks; this uses 3.

---

## Setting it up (once, about 20 minutes)

Same symbols as the deployment runbook: **🖥 VM** (SSH window), **☁️ Cloud Shell** (the `>_`
button in the Google Cloud console), **🌐 Browser**.

### 1. Merge the pull requests 🌐

Merge both, in any order:
- Boards: *Hands-off operations for the server* (adds `deploy/ops/`)
- pokemon-card-organizer: *Status file for the nightly job* (the binder's side, plus the `DOMAIN` fix)

### 2. Create the backup bucket and give the VM access to it ☁️

Open the [Google Cloud console](https://console.cloud.google.com), choose the project the `boards`
VM is in, and click **>_ (Activate Cloud Shell)** at the top right. Paste this whole block:

```bash
PROJECT=$(gcloud config get-value project 2>/dev/null)
BUCKET="$PROJECT-backups"
SA="nunner-backups@$PROJECT.iam.gserviceaccount.com"
gcloud services enable storage.googleapis.com iam.googleapis.com
gcloud storage buckets create "gs://$BUCKET" --location=us-central1 --default-storage-class=STANDARD \
  --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update "gs://$BUCKET" --clear-soft-delete
echo '{"rule": [{"action": {"type": "Delete"}, "condition": {"age": 35}}]}' > lifecycle.json
gcloud storage buckets update "gs://$BUCKET" --lifecycle-file=lifecycle.json
gcloud iam service-accounts create nunner-backups --display-name="nunner-ops: adds backup copies to Cloud Storage"
sleep 20
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member="serviceAccount:$SA" --role=roles/storage.objectCreator
echo; echo "  BACKUP_BUCKET=$BUCKET"; echo
```

**Look for:**
- `Creating gs://<project>-backups/...`, then no `ERROR` lines.
- At the end: `BACKUP_BUCKET=<your-project>-backups`. **Copy that line**; you need it in step 4.

**If not:**
- `ERROR: … 409 … already exists` on `buckets create` (bucket names are global): change the
  `BUCKET=` line to e.g. `BUCKET="$PROJECT-nunner-backups"` and paste the block again.
- `Service account … does not exist` on the last command: wait a minute and run just that line again.

Now switch the VM to that account. This needs the VM **stopped for about a minute**, and both
sites are down meanwhile:

```bash
PROJECT=$(gcloud config get-value project 2>/dev/null)
SA="nunner-backups@$PROJECT.iam.gserviceaccount.com"
ZONE=us-central1-a
gcloud compute instances stop boards --zone=$ZONE
gcloud compute instances set-service-account boards --zone=$ZONE --service-account="$SA" --scopes=cloud-platform
gcloud compute instances start boards --zone=$ZONE
gcloud compute instances describe boards --zone=$ZONE --format='value(serviceAccounts[0].email,networkInterfaces[0].accessConfigs[0].natIP)'
```

**Look for:** the last line shows `nunner-backups@<project>.iam.gserviceaccount.com` and the VM's
IP address. If the IP changed (the free VM's address can change on a restart), the DuckDNS job on
the VM updates it within 5 minutes. Both sites come back by themselves.

What this grants: the VM can **only add** files to that one bucket. It can't read, change or
delete them, and it can't touch anything else in the project.

### 3. Get a healthchecks.io ping key 🌐

1. Sign up at [healthchecks.io](https://healthchecks.io) (free Hobbyist plan) with the email
   address you want alerts sent to.
2. In your project, open **Settings**. Under **Ping key**, click **Create**, then copy the key
   (about 22 letters and digits).
3. **Integrations** already lists your email. Nothing else to set up: the three checks create
   themselves on the first run.

### 4. Install on the VM 🖥

Connect to the VM (`gcloud compute ssh boards --zone=us-central1-a --tunnel-through-iap`, or the
**SSH** button), then paste, replacing the two values:

```bash
cd ~/agile-development-operations
git pull
BACKUP_BUCKET=your-project-backups HC_PING_KEY=your-ping-key deploy/ops/install.sh
```

**Look for:**
```
Settings in /home/jnunner77/.config/nunner-ops.env:
  BACKUP_BUCKET=your-project-backups
  HC_PING_KEY=****abcd
Wrote /etc/systemd/system/nunner-ops.service
Wrote /etc/systemd/system/nunner-ops.timer
Wrote /etc/systemd/system/nunner-reboot.service
Wrote /etc/systemd/system/nunner-reboot.timer
Wrote /etc/apt/apt.conf.d/52nunner-ops
Wrote /etc/systemd/journald.conf.d/nunner-ops.conf
Removed the old backup lines from crontab (nunner-ops does them):
  */5 * * * * DUCKDNS_DOMAIN=… deploy/duckdns.sh
```
then a table with `nunner-ops.timer` (next run around 02:30 Vancouver time, shown in UTC) and
`nunner-reboot.timer`.

**If not:** `isn't in the docker group` → see Boards `deploy/README.md` step 3. `Missing …` → `sudo apt-get install -y <that tool>`.

### 5. First run, now 🖥

This one also updates the binder to the version from step 1, which builds for 5–10 minutes.
The command waits until it's done:

```bash
sudo systemctl start nunner-ops
cat ~/.local/state/nunner-ops/last-report.txt
```

**Look for** a report like this:
```
nunner-ops on boards, 2026-10-04 14:05 PDT, took 9 min 12 s

UPDATES
- boards: updated ca70ea7 → …, healthy
- binder: updated 805795c → …, healthy

DONE
- boards: backed up to /home/jnunner77/boards-backups/boards-20261004-210501.tar.gz (1.2MB)
- binder: backed up to /home/jnunner77/binder-backups/binder-20261004-210502.tar.gz (13MB)
- boards: copied to gs://your-project-backups/boards/boards-20261004-210501.tar.gz
- binder: copied to gs://your-project-backups/binder/binder-20261004-210502.tar.gz
- cleanup: freed …
- boards: https://nunner.duckdns.org answers
- binder: https://binder.nunner.duckdns.org answers
- disk: 21% used, 23000 MB free
```

with no **PROBLEMS** section. A **NEEDS YOU** section lists anything in the binder for you to do
(for example cards to match), the same things its Overview shows.

**If not:**

| Report says | Do this |
| --- | --- |
| `couldn't get Cloud Storage access from the VM's service account` | Step 2's second block didn't finish; run it again. |
| `copying the backup to gs://… failed: … 403` | The permission line in step 2 didn't run; run `gcloud storage buckets add-iam-policy-binding …` again in Cloud Shell. |
| `couldn't reach healthchecks.io` | Check the ping key in `~/.config/nunner-ops.env`. |
| `isn't a clean checkout of main` | Someone edited files on the VM. Run `cd <that folder> && git status`, then `git checkout -- .` to drop the edits (`.env` is safe; it isn't tracked). |
| `memory: no swap` | Boards `deploy/README.md` step 3 (swap). |

### 6. Check the alerts 🌐

On healthchecks.io you now have **nunner-nightly**, **nunner-attention** and **nunner-updates**.
Nightly and updates should be **up** (green). Attention is green unless the report has a
**NEEDS YOU** section.

Optional: make the "late" alert exact. For each check, **Edit schedule**, choose **Cron**,
enter `30 2 * * *`, time zone **America/Vancouver**, grace time **2 hours**. Without this, a
check goes down if a day passes with no report, which also works.

That's it. Nothing else to do unless an email arrives.

---

## Watching main

Every 5 minutes the `nunner-watch` timer runs `deploy/ops/nightly.sh --watch`:

- For each app it asks GitHub for the commit at `main` (`git ls-remote`, a few hundred bytes).
  When that's already live, it stops there and writes nothing to the log.
- When `main` moved, it updates **only that app** exactly as the nightly run does: build at low
  priority, start, health check, and **roll back** if the new version isn't healthy. The site keeps
  serving the old version while it builds (5–10 minutes on the e2-micro). No backups, base-image
  refresh or other checks; those stay nightly.
- A commit that didn't build or was rolled back **isn't tried again every 5 minutes**. The next
  merge to `main` is tried straight away, and the nightly run retries it once a night.
  To retry it now (say, after fixing the checkout on the VM):
  `rm ~/.local/state/nunner-ops/failed-binder && sudo systemctl start nunner-watch` (or `failed-boards`).
- It never overlaps the nightly run. If an update is building at 02:30, the nightly run waits for it.
- A failed or rolled-back update sets the **`nunner-updates`** check down, and healthchecks.io emails
  you. It stays down until that app is live on its latest `main` again. A site left down (the
  rollback failed too) also sets **`nunner-nightly`** down at once.

### Turning it on 🖥

It comes with `install.sh`. If `deploy/ops` was installed before watching existed, then after the
pull request that adds it is merged:

1. **Connect to the VM** (from your own computer):

   ```bash
   gcloud compute ssh boards --zone=us-central1-a --tunnel-through-iap
   ```

2. **Get the new scripts and install the timer.** Run `install.sh` with no settings; it keeps the ones in
   `~/.config/nunner-ops.env`:

   ```bash
   cd ~/agile-development-operations
   git pull
   deploy/ops/install.sh
   ```

   **Look for** `Wrote /etc/systemd/system/nunner-watch.service` and `…nunner-watch.timer`, and
   `nunner-watch.timer` in the table at the end, due within 5 minutes.

   **If not:** `isn't a clean checkout` or a `git pull` error means files were edited on the VM: run
   `git status`, then `git checkout -- .` to drop the edits (`.env` is safe; it isn't tracked).

3. **Check that it runs** (wait for the next 5-minute mark):

   ```bash
   systemctl list-timers 'nunner-*'
   systemctl status nunner-watch --no-pager
   ```

   **Look for** `nunner-watch.timer` with a `NEXT` time under 5 minutes away and a `LAST` time,
   and in the status `Active: inactive (dead)` with `status=0/SUCCESS`: it checked and found
   nothing new.

4. **Try it with your next merge.** Merge any pull request in Boards or the binder, then on the VM:

   ```bash
   journalctl -u nunner-watch -f
   ```

   Within 5 minutes you see `binder: building 1a2b3c4…` (or `boards:`). About 5–10 minutes later
   there's a short report, `binder: updated … → 1a2b3c4 (<commit title>), healthy`. Press Ctrl+C
   to stop watching. The report is also in `~/.local/state/nunner-ops/last-watch.txt`.

   Or do all of it in one line from your own computer:

   ```bash
   gcloud compute ssh boards --zone=us-central1-a --tunnel-through-iap --command 'journalctl -u nunner-watch -f' -- -t
   ```

**Settings** in `~/.config/nunner-ops.env`:

| Setting | Default | |
| --- | --- | --- |
| `WATCH_MAIN` | `on` | `off`: updates happen in the nightly run only. Run `deploy/ops/install.sh` after changing it. |
| `WATCH_MINUTES` | `5` | How often to check, 1–30 minutes. Run `deploy/ops/install.sh` after changing it. |
| `AUTO_UPDATE` | `on` | `off` stops all automatic updates, nightly and watched. |

Or set them while installing, e.g. `WATCH_MINUTES=2 deploy/ops/install.sh`.

**Free tier:** a check sends a few KB to GitHub per app, well under 50 MB a month of the 1 GB
outbound allowance at 5 minutes. A build happens only when `main` changed, the same builds the
nightly run would do, just sooner.

---

## Day to day

- **Change a setting:** edit `~/.config/nunner-ops.env` (`AUTO_UPDATE=off` stops automatic
  updates; `REFRESH_WEEKDAY=6` refreshes base images on Saturdays instead). It takes effect on
  the next run.
- **Run now:** `sudo systemctl start nunner-ops` (or `deploy/ops/nightly.sh` as yourself). To
  start it and follow along, from your own computer:
  `gcloud compute ssh boards --zone=us-central1-a --tunnel-through-iap --command 'sudo systemctl start nunner-ops --no-block && journalctl -u nunner-ops -f' -- -t`
  (Ctrl+C once the report shows; the run carries on regardless).
- **Update now, without waiting for the watch:** `sudo systemctl start nunner-watch`.
- **When it runs next:** `systemctl list-timers 'nunner-*'`.
- **History:** `journalctl -u nunner-ops --since -7d`; updates between nights:
  `journalctl -u nunner-watch --since -7d`.
- **Restore from Cloud Storage:** download an archive in the console (**Cloud Storage → Buckets →
  <your bucket> → binder/ or boards/ → Download**), upload it to the VM, then follow the
  "Roll back the ledger's data" or Boards restore steps.
- **Turn it off:** `deploy/ops/install.sh --remove` (the bucket and its copies stay).
