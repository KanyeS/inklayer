# Deploying Inklayer on AWS Lightsail (~$7/month)

This guide runs Inklayer on a single Lightsail instance:
- **HTTPS:** automatic, through Caddy and Let's Encrypt.
- **Database:** a SQLite file on the instance's SSD.
- **Backup:** continuous, to S3 through [Litestream](https://litestream.io). It is about one second behind, with 7 days of point-in-time history.

```
            Internet
               │ :443
        ┌──────▼──────┐   Lightsail instance (1 GB, 40 GB SSD)
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
| Lightsail Linux, 1 GB plan (includes a static IPv4 address and at least 1 TB of transfer) | ~$7.00 |
| S3 backups (a few hundred MB plus requests) | < $0.10 |
| Domain name | ~$1 (varies) |

Check current prices at <https://aws.amazon.com/lightsail/pricing/>. The $5 plan (512 MB) is too small: the system and Docker use most of its memory, it swaps constantly, and it runs out of CPU credits, which can take the site down during updates.

## 1. Create the S3 backup bucket and credentials

This is the default setup (`LITESTREAM_AUTH=keys`): an S3 bucket, and an access key that can only reach that bucket. To avoid storing a key on the server, see [Keyless backups](#keyless-backups-optional) instead, and skip this step.

1. **Create the bucket.** In the S3 console, create a bucket such as `acme-inklayer-backups`, in the same region you'll use for Lightsail. Keep **Block all public access** on.
2. **Create a policy.** In IAM → Policies → Create policy → JSON, paste [`deploy/lightsail/iam-policy.json`](../deploy/lightsail/iam-policy.json), replacing `YOUR-INKLAYER-BACKUPS` with your bucket name. Name it `inklayer-litestream`.
3. **Create a user.** In IAM → Users → Create user, name it `inklayer-litestream` with no console access, and attach only that policy.
4. **Create an access key.** On that user, go to Security credentials → Create access key and choose "Application running outside AWS". Save both values; you'll need them in step 5.

The key can only read and write that one bucket. If the server is ever compromised, nothing else in your AWS account is exposed.

## 2. Create the Google sign-in client

Inklayer never stores passwords; everyone signs in with Google.

1. **Create or choose a project** in [Google Cloud Console](https://console.cloud.google.com/).
2. **Set up the consent screen.** Go to APIs & Services → OAuth consent screen (Google Auth Platform → Branding/Audience):
   - **Audience:** choose **Internal** if everyone uses your Google Workspace domain, or **External** for anyone with a Google account.
   - **Scopes:** add only `openid`, `email` and `profile`. These are non-sensitive, so no Google verification review is needed.
   - **Publishing status:** for **External**, set it to **In production**. In "Testing", only the test users you list can sign in.
3. **Create the client.** Go to APIs & Services → Credentials → **Create credentials → OAuth client ID**:
   - **Application type:** **Web application**.
   - **Authorised redirect URI:** `https://inklayer.example.com/auth/callback/google`, using your domain.
4. **Save the credentials.** Copy the **Client ID** and **Client secret**; they go into `.env` in step 5.

## 3. Create the Lightsail instance

1. **Create the instance.** Lightsail → Create instance → Linux/Unix → **OS only → Ubuntu 24.04 LTS**, and choose the **$7 (1 GB)** plan.
2. **Attach a static IP.** In Networking → Create static IP, attach it to the instance. A static IP is free while attached.
3. **Open the firewall.** In the instance's Networking tab, under the IPv4 firewall, add **HTTPS (443)**. **SSH (22)** and **HTTP (80)** are open by default. Caddy needs port 80 for Let's Encrypt validation and HTTP→HTTPS redirects.
4. **Turn on snapshots.** In the instance's Snapshots tab, turn on **automatic snapshots**. They cost a few cents a month and act as a second safety net.
5. **Point DNS at the server.** At your DNS provider, create an `A` record for `inklayer.example.com` pointing at the static IP. If the DNS provider is Cloudflare, turn its proxy off ("DNS only"), so Caddy can get its certificate.

## 4. Publish the server image

Images are built by GitHub Actions, not on the instance, which doesn't have the RAM to compile .NET.

```bash
git tag v0.1.0
git push origin v0.1.0
```

The **Release image** workflow pushes `ghcr.io/<owner>/inklayer-server:0.1.0` and `:latest`, for both amd64 and arm64.

> GitHub creates new container packages as **private**. Either make the package public (GitHub → your profile → Packages → inklayer-server → Package settings → Change visibility), or run `docker login ghcr.io` on the instance with a token that has the `read:packages` scope.

## 5. Install on the instance

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
| `LITESTREAM_AUTH` | `keys` (default), or `instance` for [keyless backups](#keyless-backups-optional) |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | from step 1 (leave empty with `LITESTREAM_AUTH=instance`) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | from step 2 |
| `INKLAYER_BOOTSTRAP_ADMINS` | your Google email address. It becomes an instance administrator on first sign-in. |
| `INKLAYER_EXTENSION_REDIRECT_URIS` | leave empty until the browser extension is installed |

Then start the stack:

```bash
docker compose up -d
docker compose ps
curl -fsS https://inklayer.example.com/health/ready     # → Healthy
```

Open `https://inklayer.example.com/auth/login` and sign in with the bootstrap admin account. Then create your organisation and invite people with the API (`POST /api/orgs`, `POST /api/orgs/{id}/invitations`). A web UI for this comes with the viewer.

On first start, the services run in this order:
1. `volume-init` sets permissions on the data volume.
2. `restore` finds no backup and exits cleanly.
3. The server creates a new database.
4. Litestream starts streaming it to S3.

## Keyless backups (optional)

Lightsail instances can't have IAM roles, so by default Litestream uses an access key. Instead, you can back up to a **Lightsail bucket** and attach the instance to it ("resource access"). The instance then gets short-lived credentials automatically, and no key is stored on the server.

Trade-offs compared with the default:
- **Cost:** the smallest Lightsail bucket plan is about $1/month, compared with a few cents for S3.
- **Scope:** an attached instance gets full access to that bucket, while the default IAM policy only allows reading, writing and deleting objects. Use the bucket for Inklayer backups only.

Setup:
1. **Create the bucket.** Lightsail → Storage → Create bucket, in the **same region** as the instance, on the smallest plan. Leave it private.
2. **Attach the instance.** In the bucket's Permissions tab, under Resource access, choose **Attach instance** and pick your Inklayer instance.
3. **Configure `.env`.** Set `LITESTREAM_BUCKET` to the bucket's name, `AWS_REGION` to its region, `LITESTREAM_AUTH=instance`, and leave `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` empty.

Then continue with step 5 as usual. To check that it works, run `docker compose logs --tail=50 litestream` and look for errors. The `litestream` and `restore` containers use host networking in this mode, so they can reach the instance metadata service.

To switch an existing install, set `LITESTREAM_AUTH` and run `docker compose up -d`. A new bucket starts empty, so Litestream writes a fresh full snapshot to it; the old bucket's history isn't copied over.

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
**The instance was lost or rebuilt.** Create a new instance, then repeat steps 3 and 5 with the same `.env`. On first start, `restore` pulls the latest database from S3 automatically, because the new volume is empty.

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

### Locked out?
If no instance administrator can sign in, add a working Google email to `INKLAYER_BOOTSTRAP_ADMINS` in `.env` and run `docker compose up -d`. That account becomes an administrator on its next sign-in.

### Keys
`/data/keys` holds the token-signing keys and the cookie-protection keys. They are created on first start, and they aren't stored in the S3 backup. If they're lost, everyone simply signs in again; no data is lost.

### Watching memory
```bash
free -m
docker stats --no-stream
```
The server is capped at a 192 MB heap and a 320 MB container limit. If `docker compose ps` shows the server restarting with exit code 137 (killed for running out of memory), or swap use stays high, move to a larger plan: stop the stack (`docker compose stop`), take an instance snapshot, create a new instance from it on the larger plan, and move the static IP over.

### Disk
Inklayer stores only its database, which stays small. Check with `df -h /`; Docker images are the main use of disk, and `docker image prune` clears old ones.

## Limits of this setup
- **One instance.** SQLite allows one writer, so don't run two servers against the same database or the same Litestream bucket path.
- **Downtime during updates and instance maintenance.** It is usually seconds.
- **Data-loss window.** The last ~1 second of writes can be lost if the instance dies abruptly; Lightsail snapshots add a daily fallback.
