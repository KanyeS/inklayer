# Deploying Inklayer on AWS Lightsail (~$5/month)

This guide runs Inklayer on a single Lightsail instance:
- **HTTPS:** automatic, through Caddy and Let's Encrypt.
- **Database:** a SQLite file on the instance's SSD.
- **Backup:** continuous, to S3 through [Litestream](https://litestream.io). It is about one second behind, with 7 days of point-in-time history.

```
            Internet
               │ :443
        ┌──────▼──────┐   Lightsail instance (512 MB, 20 GB SSD)
        │    Caddy    │   automatic HTTPS
        └──────┬──────┘
        ┌──────▼──────┐        ┌────────────┐
        │  Inklayer   │──────▶ │ inklayer.db│ (SQLite, WAL)
        │   server    │        └─────┬──────┘
        └─────────────┘              │ streamed changes
                              ┌──────▼──────┐        ┌───────────┐
                              │ Litestream  │──────▶ │  S3 bucket │
                              └─────────────┘        └───────────┘
```

## Cost

| Item | Monthly |
|---|---|
| Lightsail Linux, 512 MB plan (includes a static IPv4 address and 1 TB of transfer) | ~$5.00 |
| S3 backups (a few hundred MB plus requests) | < $0.10 |
| Domain name | ~$1 (varies) |

Check current prices at <https://aws.amazon.com/lightsail/pricing/>. If memory runs short (see [Operations](#operations)), the 1 GB plan costs about $2 more.

## 1. Create the S3 backup bucket and credentials

1. **Create the bucket.** In the S3 console, create a bucket such as `acme-inklayer-backups`, in the same region you'll use for Lightsail. Keep **Block all public access** on.
2. **Create a policy.** In IAM → Policies → Create policy → JSON, paste [`deploy/lightsail/iam-policy.json`](../deploy/lightsail/iam-policy.json), replacing `YOUR-INKLAYER-BACKUPS` with your bucket name. Name it `inklayer-litestream`.
3. **Create a user.** In IAM → Users → Create user, name it `inklayer-litestream` with no console access, and attach only that policy.
4. **Create an access key.** On that user, go to Security credentials → Create access key and choose "Application running outside AWS". Save both values; you'll need them in step 4.

The key can only read and write that one bucket. If the server is ever compromised, nothing else in your AWS account is exposed.

## 2. Create the Lightsail instance

1. **Create the instance.** Lightsail → Create instance → Linux/Unix → **OS only → Ubuntu 24.04 LTS**, and choose the **$5 (512 MB)** plan.
2. **Attach a static IP.** In Networking → Create static IP, attach it to the instance. A static IP is free while attached.
3. **Open the firewall.** In the instance's Networking tab, under the IPv4 firewall, add **HTTPS (443)**. **SSH (22)** and **HTTP (80)** are open by default. Caddy needs port 80 for Let's Encrypt validation and HTTP→HTTPS redirects.
4. **Turn on snapshots.** In the instance's Snapshots tab, turn on **automatic snapshots**. They cost a few cents a month and act as a second safety net.
5. **Point DNS at the server.** At your DNS provider, create an `A` record such as `inklayer.example.com` → the static IP.

## 3. Publish the server image

Images are built by GitHub Actions, not on the instance. 512 MB isn't enough RAM to compile .NET.

```bash
git tag v0.1.0
git push origin v0.1.0
```

The **Release image** workflow pushes `ghcr.io/<owner>/inklayer-server:0.1.0` and `:latest`, for both amd64 and arm64.

> GitHub creates new container packages as **private**. Either make the package public (GitHub → your profile → Packages → inklayer-server → Package settings → Change visibility), or run `docker login ghcr.io` on the instance with a token that has the `read:packages` scope.

## 4. Install on the instance

SSH in from the Lightsail console's "Connect using SSH", or with your key. Then:

```bash
curl -fsSLO https://raw.githubusercontent.com/<owner>/inklayer/main/deploy/lightsail/bootstrap.sh
less bootstrap.sh                                   # review it
sudo INKLAYER_REPO_RAW=https://raw.githubusercontent.com/<owner>/inklayer/main bash bootstrap.sh
exit                                                # log back in so the docker group membership applies
```

The script adds a 1 GB swap file, installs Docker, turns on automatic security updates, and puts the deployment files in `/opt/inklayer`.

Next, edit the configuration:

```bash
cd /opt/inklayer
nano .env
```

| Variable | Example |
|---|---|
| `INKLAYER_IMAGE` | `ghcr.io/<owner>/inklayer-server:0.1.0` (pin a version; `latest` works but makes updates less predictable) |
| `INKLAYER_DOMAIN` | `inklayer.example.com` |
| `ACME_EMAIL` | your email address, for certificate expiry notices |
| `LITESTREAM_BUCKET` | `acme-inklayer-backups` |
| `AWS_REGION` | `us-east-1` |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | from step 1 |

Then start the stack:

```bash
docker compose up -d
docker compose ps
curl -fsS https://inklayer.example.com/health/ready     # → Healthy
```

On first start, the services run in this order:
1. `volume-init` sets permissions on the data volume.
2. `restore` finds no backup and exits cleanly.
3. The server creates a new database.
4. Litestream starts streaming it to S3.

## Operations

### Updating
```bash
cd /opt/inklayer
sed -i 's#inklayer-server:.*#inklayer-server:0.2.0#' .env
docker compose pull && docker compose up -d
```
Expect a few seconds of downtime while the server restarts. Database migrations run automatically on startup.

### Checking backups
```bash
docker compose logs --tail=50 litestream
# Dry-run a restore from S3 into a scratch path (doesn't touch the live database):
docker compose run --rm restore restore -dry-run -o /tmp/check.db /data/inklayer.db
```
Also check the S3 console: objects under `inklayer.db/` should keep updating as people use the app.

### Restoring
**The instance was lost or rebuilt.** Create a new instance, then repeat steps 2 and 4 with the same `.env`. On first start, `restore` pulls the latest database from S3 automatically, because the new volume is empty.

**Rolling back to a point in time**, for example after a bad change:
```bash
cd /opt/inklayer
docker compose stop server litestream
docker compose run --rm restore restore -o /data/restored.db -timestamp 2026-11-18T09:00:00Z /data/inklayer.db
# Check restored.db, then swap it in:
docker compose run --rm --entrypoint sh restore -c 'cd /data && mv inklayer.db inklayer.db.bad && rm -f inklayer.db-wal inklayer.db-shm && mv restored.db inklayer.db'
docker compose up -d
```

> Never copy `inklayer.db` with `cp` while the server is running; the copy can be inconsistent. Use Litestream, or `sqlite3 inklayer.db "VACUUM INTO 'copy.db'"`.

### Watching memory
```bash
free -m
docker stats --no-stream
```
The server is capped at a 192 MB heap and a 320 MB container limit. If `docker compose ps` shows the server restarting with exit code 137 (killed for running out of memory), or swap use stays high, move to the 1 GB plan: Lightsail → Snapshots → create a new instance from the snapshot on the larger plan → move the static IP over.

### Disk
Captured pages take roughly 2–20 MB each, and 20 GB holds several thousand. Check with `df -h /`. Moving snapshot assets to S3 is on the roadmap.

## Limits of this setup
- **One instance.** SQLite allows one writer, so don't run two servers against the same database or the same Litestream bucket path.
- **Downtime during updates and instance maintenance.** It is usually seconds.
- **Data-loss window.** The last ~1 second of writes can be lost if the instance dies abruptly; Lightsail snapshots add a daily fallback.
