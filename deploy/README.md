# Deploying Boards

The app ships as a Docker image. `docker-compose.yml` runs it behind [Caddy](https://caddyserver.com),
which gets and renews a free HTTPS certificate automatically. Data lives in a Docker volume, so
rebuilding or upgrading the app never touches it.

This guide sets it up on a **Google Cloud "always free" e2-micro VM** with a free
**DuckDNS** host name. The same steps work on any Linux server with Docker; skip the Google Cloud
and DuckDNS parts if you already have a server and a domain.

> **Check the free-tier terms before you start.** When this was written, Google's free tier
> included one e2-micro VM per month in `us-west1`, `us-central1` or `us-east1`, 30 GB of
> standard persistent disk and 1 GB of outbound traffic (plenty for a team tracker). Google also
> charges for external IPv4 addresses on many VMs; confirm on the
> [free tier page](https://cloud.google.com/free/docs/free-cloud-features#compute) whether the
> free VM's address is covered, and set a budget alert (step 1) so any charge shows up early.

## What you need

- A Google account with billing enabled (a card is required even for free-tier use).
- A free [DuckDNS](https://www.duckdns.org) account (sign in with GitHub or Google).
- About 30 minutes.

## 1. Create the VM

In the [Google Cloud console](https://console.cloud.google.com):

1. Create a project (or pick one), then **Billing → Budgets & alerts → Create budget** with a
   budget of $1 so you're emailed if anything is ever charged.
2. Open **Cloud Shell** (the `>_` icon at the top right). First enable Compute Engine for the
   project (billing must be linked to the project for this to work):

   ```bash
   gcloud services enable compute.googleapis.com
   ```

   Give it a minute or two after this finishes: the project's default network is still being
   set up, and creating a VM too soon fails with a "Retry … network connectivity issues" error.
   If you see that, wait a minute and run the command again. Then create the VM and firewall rule:

   ```bash
   gcloud compute instances create boards \
     --zone=us-central1-a \
     --machine-type=e2-micro \
     --image-family=debian-12 --image-project=debian-cloud \
     --boot-disk-size=30GB --boot-disk-type=pd-standard \
     --tags=boards-web

   gcloud compute firewall-rules create boards-allow-web \
     --allow=tcp:80,tcp:443,udp:443 --target-tags=boards-web
   ```

   The machine type, one of the three free regions, and the 30 GB *standard* disk are what keep
   it inside the free tier.

3. Note the VM's **external IP** from the output (or **Compute Engine → VM instances**).

## 2. Get a host name

1. Sign in at [duckdns.org](https://www.duckdns.org), add a subdomain (e.g. `yourteam` →
   `yourteam.duckdns.org`) and set its IP to the VM's external IP.
2. Copy the **token** shown at the top of the DuckDNS page; you'll use it in step 4.

## 3. Prepare the VM

Connect with `gcloud compute ssh boards --zone=us-central1-a` (or the **SSH** button in the
console), then:

```bash
# 2 GB of swap: the e2-micro has 1 GB of RAM, and building the image needs a bit more.
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Docker and git
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
sudo apt-get install -y git
exit   # sign out and back in so the docker group applies
```

## 4. Install the app

Reconnect, then clone the repository:

```bash
git clone https://github.com/jnunner77/agile-development-operations.git
cd agile-development-operations
```

If the repository is private, GitHub will ask for credentials: use your GitHub username and a
[fine-grained personal access token](https://github.com/settings/personal-access-tokens) with
read-only **Contents** access to this repository as the password.

Keep the DuckDNS name pointed at the VM (the external IP can change if the VM is stopped and
started):

```bash
chmod +x deploy/*.sh
DUCKDNS_DOMAIN=yourteam DUCKDNS_TOKEN=your-token deploy/duckdns.sh && echo updated
( crontab -l 2>/dev/null; echo "*/5 * * * * DUCKDNS_DOMAIN=yourteam DUCKDNS_TOKEN=your-token $PWD/deploy/duckdns.sh" ) | crontab -
```

Configure and start:

```bash
cp deploy/.env.example .env
nano .env          # set DOMAIN=yourteam.duckdns.org, and SEED=empty or demo
docker compose up -d --build
docker compose ps  # both services should be "running"; the app shows "(healthy)"
```

The first build takes several minutes on an e2-micro. Caddy then requests the certificate;
open `https://yourteam.duckdns.org` once `docker compose logs caddy` shows `certificate obtained`.

## 5. Turn on sign-in straight away

Until sign-in is on, anyone who finds the address can use the app and make themselves an
administrator. Right after the first start:

1. **Project settings → Team members**: give yourself a username and make yourself an administrator.
2. Turn sign-in on, sign in and choose your password.
3. Add everyone else with a username (see *Sign-in* in the main README).

## 6. Connect GitHub (optional)

To link branches, commits and pull requests to work items, sign in as an administrator, open
**Project settings → Integrations**, and follow the three steps there: create a secret, add
the webhook in your GitHub repository (`https://yourteam.duckdns.org/api/integrations/github/webhook`,
content type `application/json`), and check the *ping* arrives under *Recent deliveries*.

## Day-to-day

**Upgrade to the latest `main`:**

```bash
cd ~/agile-development-operations
git pull
docker compose build --pull
docker compose up -d
```

**Backups.** Snapshots live on the VM's disk, so also copy data off it. `deploy/backup.sh`
archives the database, snapshots and sign-in accounts to `~/boards-backups`, keeping the latest 14.
Run it nightly:

```bash
( crontab -l; echo "0 3 * * * cd $PWD && deploy/backup.sh >> $HOME/boards-backup.log 2>&1" ) | crontab -
```

Then download archives now and then (`gcloud compute scp boards:~/boards-backups/* .`), or use
**Project settings → Snapshots & backups → Export backup** in the app. To restore an archive:

```bash
docker compose stop app
docker compose run --rm --no-deps -T app sh -c 'rm -rf /data/* && tar xzf - -C /data' < ~/boards-backups/boards-YYYYMMDD-HHMMSS.tar.gz
docker compose start app
```

**Logs:** `docker compose logs -f app` (or `caddy`).

**Locked out of every admin account:** add `AUTH_DISABLED: "1"` under `app → environment` in
`docker-compose.yml`, run `docker compose up -d`, fix the accounts, then remove it and run
`docker compose up -d` again.

## Security

The app is built to sit on the open internet. Protections, from the outside in:

| Layer | What it does |
| --- | --- |
| Google Cloud firewall | Only ports 80 and 443 are open to the world (and SSH, until you lock it down below). |
| Caddy | HTTPS only (HTTP redirects), HSTS; drops slow or oversized requests (10 s to send headers, 60 s for a body, 60 MB max, 16 KB of headers); closes the connection on well-known attack-scanner paths (`/.env`, `/wp-admin`, `*.php`, …); allows only the HTTP methods the app uses. |
| App: rate limits | Per client IP for everything; per signed-in person for API use and for changes; a strict limit for anonymous callers while sign-in is on; 5 sign-in attempts per minute per IP; backups, snapshots and imports limited to about one a minute. Limited requests get `429` with `Retry-After`. |
| App: temporary blocks | An IP is blocked for an hour after repeatedly hitting limits, 20 failed sign-ins in 10 minutes, or probing many non-existent API paths. Blocks are logged (`docker compose logs app | grep security`). |
| App: sign-in | Per-username lockout after 5 wrong passwords; slow salted password hashing, with at most 4 checks running at once so floods can't exhaust the CPU; sessions end after the inactivity timeout and after 24 hours regardless; at most 20 sessions per person. |
| App: requests | 2 MB body limit (50 MB only for an administrator importing a backup, checked before the upload is read); changes from other websites are refused (cross-site request forgery); at most 10 live-update connections per person and 50 per IP; slow-request timeouts. |
| App: browser | Strict Content Security Policy (scripts, styles and connections only from the app itself), no framing, `nosniff`, no referrer leaks, API responses never cached; all rich text is sanitized. |
| Containers | Read-only file systems (only the data volume and a small `/tmp` are writable), all Linux capabilities dropped (Caddy keeps only the right to bind ports 80/443), no privilege escalation, memory and process limits, rotated logs. The app runs as an unprivileged user. |

**Shared office addresses.** Limits apply per IP before sign-in, so many people behind one
office address share that IP's allowance. If an office gets limited or blocked, add its public
address to `SECURITY_ALLOWLIST` in `.env` (e.g. `SECURITY_ALLOWLIST=203.0.113.10`, or a range such
as `203.0.113.0/24`) and run `docker compose up -d`.

**Lifting a block early:** `docker compose restart app` clears all blocks and limits.

### Harden the VM (recommended)

**Lock SSH down to Google's tunnel.** By default Google's `default-allow-ssh` firewall rule
lets the whole internet try to connect to SSH. Route SSH through Identity-Aware Proxy instead, so
only you, signed in to Google, can reach it. In Cloud Shell:

```bash
gcloud services enable iap.googleapis.com
gcloud compute firewall-rules create boards-allow-ssh-iap \
  --allow=tcp:22 --source-ranges=35.235.240.0/20 --target-tags=boards-web

# Check you can connect through the tunnel BEFORE removing the open rule:
gcloud compute ssh boards --zone=us-central1-a --tunnel-through-iap

# Then close SSH (and RDP, which a Linux VM never needs) to the internet:
gcloud compute firewall-rules delete default-allow-ssh default-allow-rdp
```

From then on, always connect with `--tunnel-through-iap`.

**Automatic security updates** for the operating system (on the VM):

```bash
sudo apt-get install -y unattended-upgrades
echo 'unattended-upgrades unattended-upgrades/enable_auto_updates boolean true' | sudo debconf-set-selections
sudo dpkg-reconfigure -f noninteractive unattended-upgrades
```

**Keep the containers current:** when you upgrade the app, also refresh the base images:

```bash
git pull
docker compose build --pull
docker compose pull caddy
docker compose up -d
```

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Browser can't connect | `docker compose ps`; the firewall rule from step 1; the DuckDNS IP matches the VM's external IP |
| Certificate errors in `docker compose logs caddy` | DNS must point at the VM and ports 80 and 443 must be open *before* Caddy can get a certificate; fix, then `docker compose restart caddy` |
| Build is killed or very slow | Swap from step 3 is on (`swapon --show`) |
| Live updates don't arrive | Something between you and Caddy is buffering; the Caddyfile already disables compression for `/api/events` |
| "Too many requests" or "temporarily blocked" | Wait (limits refill within a minute; blocks last an hour), or `docker compose restart app`; for a shared office address see *Shared office addresses* above |

## Configuration reference

| Setting | Where | Purpose |
| --- | --- | --- |
| `DOMAIN` | `.env` | Public host name Caddy serves and gets a certificate for |
| `SEED` | `.env` | `demo` or `empty`; only used when no database exists yet |
| `TRUST_PROXY` | `docker-compose.yml` | Set to `1` so the app trusts Caddy's `X-Forwarded-*` headers (HTTPS detection for Secure cookies). Only set it when a proxy is in front. |
| `AUTH_DISABLED` | `docker-compose.yml` | Emergency sign-in override (see above) |
| `SECURITY_ALLOWLIST` | `.env` | IPs or IPv4 ranges never rate limited or blocked |

The container serves `GET /api/health` (no sign-in needed) for health checks, runs as an
unprivileged user and stores everything under `/data`.
