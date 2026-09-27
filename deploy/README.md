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
2. Open **Cloud Shell** (the `>_` icon at the top right) and run:

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
   it inside the free tier. Enable the Compute Engine API if prompted.

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

## Day-to-day

**Upgrade to the latest `main`:**

```bash
cd ~/agile-development-operations
git pull
docker compose up -d --build
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

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Browser can't connect | `docker compose ps`; the firewall rule from step 1; the DuckDNS IP matches the VM's external IP |
| Certificate errors in `docker compose logs caddy` | DNS must point at the VM and ports 80 and 443 must be open *before* Caddy can get a certificate; fix, then `docker compose restart caddy` |
| Build is killed or very slow | Swap from step 3 is on (`swapon --show`) |
| Live updates don't arrive | Something between you and Caddy is buffering; the Caddyfile already disables compression for `/api/events` |

## Configuration reference

| Setting | Where | Purpose |
| --- | --- | --- |
| `DOMAIN` | `.env` | Public host name Caddy serves and gets a certificate for |
| `SEED` | `.env` | `demo` or `empty`; only used when no database exists yet |
| `TRUST_PROXY` | `docker-compose.yml` | Set to `1` so the app trusts Caddy's `X-Forwarded-*` headers (HTTPS detection for Secure cookies). Only set it when a proxy is in front. |
| `AUTH_DISABLED` | `docker-compose.yml` | Emergency sign-in override (see above) |

The container serves `GET /api/health` (no sign-in needed) for health checks, runs as an
unprivileged user and stores everything under `/data`.
