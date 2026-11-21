# Load testing

There are two load tests. Both use the same [k6](https://k6.io) script, [`loadtest/k6/inklayer.js`](../loadtest/k6/inklayer.js).

| | **Load test** (every push to main) | **Load test (Lightsail)** (on demand) |
|---|---|---|
| Question | Did this change make the server slower or less stable? | How much can the production box really take? |
| Where | On the GitHub runner, with the box's limits: 2 CPUs, 448 MB, a 256 MB heap | Two throwaway Lightsail instances: the server on the production plan, k6 on another |
| Load | Fixed and modest for 2 minutes: 40 reads/s, 5 comment writes/s, 40 live connections, 5 people typing in docs, 4 people playing recordings, 6 recorded comments and 4 issues with attachments a minute | Steps up until it breaks (`capacity`), or holds one rate for an hour or more (`soak`) |
| Result | Pass/fail on response times and errors, with a table in the run summary | A table per step and the capacity figure, CPU credits, server CPU and memory |
| Cost | Free, about 6 minutes | A few cents, about 20–30 minutes (longer for soak) |

Neither touches production: each run gets a fresh, empty database, no Litestream, no real sign-in and no real tracker.

## What the test does

Five kinds of traffic run side by side, so the summary shows each one's limits separately:

- **Reads:** what opening pages and docs costs. Comment lists for a page (most of the traffic), single comments, `/api/me`, the doc tree, a doc and doc search. A tenth of the reads load one busy page covered in 60 freehand drawings of 20 KB each. Its comment list carries every drawing's points (about 1.2 MB), so it's the heaviest read: before drawings were passed through as stored, 15 people loading a page with 100 drawings at once ran the server out of memory.
- **Writes:** posting comments and replies. SQLite allows one writer at a time, so this is where queueing and `SQLITE_BUSY` errors appear first.
- **Live:** extension tabs that hold the presence WebSocket open and move the cursor twice a second. Each connection holds memory, so this shows memory per connection.
- **Doc editing:** people typing in docs through the docs hub, as the viewer's editor does. While typing, an edit is saved every 250 ms (its own database transaction) and carets are relayed about every 120 ms. After each pause (8 s typing, 6 s pause) the tab saves a snapshot: the merged state plus the markdown, which the server indexes for search and adds to history. Editors share 5 docs, so several people are in each one, their edits are relayed to each other and their snapshots race. The server never reads the edit bytes, so the test sends random bytes of a realistic size through the same storage path. In real use this is usually the heaviest writer: one person typing makes about 4 writes a second.
- **Media:** the large files. People make comments with a screenshot, a full-page screenshot, a recording (20 MB by default, `VIDEO_MB`) and its still. Others play the recordings the way a video player does: `Range: bytes=0-` (the whole file), sometimes followed by a seek. Others make issues from those comments, which sends all the files to a tracker. The tracker is a fake GitLab in the stack ([`loadtest/fake-gitlab.py`](../loadtest/fake-gitlab.py)) behind its own Caddy at `https://gitlab.internal`. It reads every upload to the end and throws it away. The server trusts only that Caddy's certificate authority, so it can't reach anything else. Memory runs out here first: before the fix in this change, two people playing one 40 MB recording made the server run out of memory, and the `ci` profile's media load got it killed in under 30 seconds. `MEDIA=off` leaves this traffic out.

Before the test starts, k6 signs in, creates an organisation, a project, comments across 25 pages and 40 docs.

**Signing in:** the stack includes a stand-in OpenID Connect provider ([mock-oauth2-server](https://github.com/navikt/mock-oauth2-server)) that signs in one load-test user without a login form. k6 goes through the server's normal OIDC sign-in, so the server has no test-only way in. Caddy runs in front with production's own [`Caddyfile`](../deploy/lightsail/Caddyfile), as on the real box. The sign-in cookies are HTTPS-only, so this is needed as well as realistic.

## On every push to main

[`.github/workflows/loadtest.yml`](../.github/workflows/loadtest.yml) builds the image and runs the `ci` profile. It fails when any of these is true:

| Check | Limit |
|---|---|
| Read p95 | 300 ms |
| Write p95 (comments, replies) | 600 ms |
| Doc save p95 (one edit, sent to stored) | 600 ms |
| Failed reads or writes | 1% |
| Failed checks (wrong status codes) | 1% |
| Live or docs connections dropped or refused, or a doc edit refused | any |
| Media p95 (uploads, whole recordings, issues with files) | 10 s |
| Failed media requests | 1% |

The run summary has the k6 thresholds and a table per 30 seconds, including the server's CPU and memory. The artifact `loadtest-results` has the raw numbers and the server log.

GitHub's runners vary in speed. The limits are set well above normal results (around 10–20 ms on a typical runner), so a failure means something really changed. If a run fails, look at the per-30-seconds table and the server log first, then run it again before you start looking for a cause.

## On demand: the real limits on Lightsail

In Actions → **Load test (Lightsail)** → Run workflow:

- `capacity` steps the load from a tenth of the maximums to the maximums (default 300 reads/s, 30 comment writes/s, 300 live connections, 60 people typing in docs, and 20 people playing recordings, 20 recorded comments and 20 issues with attachments a minute, in 10 one-minute steps). If every step holds, the summary says to raise the maximums and run again.
- `soak` holds one rate (default 100 reads/s, 10 comment writes/s, 10 people typing) for an hour. Run it at about 70% of the capacity figure. It shows what `capacity` can't: the box running out of **CPU credits** (Lightsail plans are burstable), memory growing over time, and the database's WAL file growing.

The workflow creates `inklayer-loadtest-<run id>-server` (your chosen plan, `micro_3_0` = production's 1 GB plan) and `-k6` (`medium_3_0`, so k6 is never the bottleneck) in the same zone. k6 reaches the server over its private address; nothing is published to the internet. The last step deletes both instances and the key pair, even if the run fails or is cancelled.

**Check after a cancelled run:** in the Lightsail console, look for instances named `inklayer-loadtest-*`. If one is left, delete it by hand.

### Reading the result

An example (made-up numbers):

```
| Step | Reads/s | Writes/s | Doc saves/s | Media/min | Read p95 | Write p95 | Doc save p95 | Media p95 | Errors | WebSocket sessions started | Live/doc errors | Server CPU (max) | Server memory (max) |
| 3 ✅ | 90.0    | 9.0      | 70.0        | 600       | 40 ms    | 55 ms     | 30 ms        | 900 ms    | 0.00%  | 120                        | 0               | 140%             | 210 MiB             |
| 4 ❌ | 120.0   | 12.0     | 95.0        | 800       | 900 ms   | 2,100 ms  | 1,800 ms     | 25,000 ms | 3.10%  | 160                        | 0               | 200%             | 318 MiB             |
```

- A step holds (✅) while read p95 ≤ 500 ms, write p95 ≤ 1 s, doc save p95 ≤ 1 s, media p95 ≤ 20 s, errors ≤ 1% and no live or docs connection failed. `Media/min` counts media requests: uploads, plays, seeks and issues. The **capacity** is the busiest step that held, with every step before it holding too.
- **Server CPU** is out of 200% (2 vCPUs). At 200%, the CPU is the limit.
- **Server memory** near 448 MiB means the container is at its cap: expect slow garbage collection and then an out-of-memory restart (the summary's last line says whether it was restarted).
- **CPU credits** (`BurstCapacityPercentage`): at 100% the box hasn't touched its reserve. Near 0% it's down to its baseline speed, and results from then on are what it can sustain. A `capacity` run is usually too short to drain them: that's what `soak` is for.
- To turn the numbers into people (estimates from the client's timers): an active person makes about 5–12 reads a minute (page loads, the extension's 60 s refresh, the viewer's 15–30 s refreshes on docs), a comment or reply every few minutes, and about 4 doc saves a second while typing. So 15 active people are about 1.5–3 reads/s with bursts of 10–20, under 0.1 comment writes/s, and 4 doc saves/s per person typing at that moment. Leave plenty of headroom; real traffic comes in bursts.

### One-time setup (AWS)

The workflow signs in to AWS with GitHub's OpenID Connect, so no AWS key is stored in GitHub.

1. **Add GitHub as an identity provider** (once per AWS account). IAM → Identity providers → Add provider → OpenID Connect, provider URL `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`.
2. **Create a policy.** IAM → Policies → Create policy → JSON. Paste [`loadtest/aws-iam-policy.json`](../loadtest/aws-iam-policy.json) and name it `inklayer-loadtest`. It can only delete instances and key pairs tagged `inklayer-loadtest=true`, which the workflow tags its own with. It can't delete the production instance.
3. **Create a role.** IAM → Roles → Create role → Web identity, choose `token.actions.githubusercontent.com` and audience `sts.amazonaws.com`, and limit it to your repository (`KanyeS/inklayer`). Attach `inklayer-loadtest`. Name it `inklayer-loadtest`.
4. **Add the secret.** GitHub → repository Settings → Secrets and variables → Actions → New repository secret: `AWS_LOADTEST_ROLE_ARN` = the role's ARN.

If the server image is private on ghcr.io, the workflow signs the instance in to ghcr.io with the run's own token, so nothing else is needed.

## Running it on your own machine

Requires Docker. Results go to `loadtest/results/` (ignored by git).

```bash
docker build -f deploy/Dockerfile -t inklayer-server:local .
export INKLAYER_IMAGE=inklayer-server:local
docker compose -f loadtest/docker-compose.yml up -d caddy fake-gitlab-tls

# CI profile (2 minutes)
docker compose -f loadtest/docker-compose.yml run --rm k6

# Capacity, short steps, with the server's CPU and memory
loadtest/stats.sh inklayer-loadtest-server-1 2 > loadtest/results/stats.csv &
docker compose -f loadtest/docker-compose.yml run --rm -e PROFILE=capacity -e STEPS=8 -e STEP_SECONDS=30 \
  -e MAX_READ_RPS=600 -e MAX_WRITE_RPS=60 -e MAX_LIVE_CONNECTIONS=300 -e MAX_DOC_EDITORS=60 k6
python3 loadtest/report.py loadtest/results/metrics.csv.gz --step-seconds 30 --steps 8 --stats loadtest/results/stats.csv

docker compose -f loadtest/docker-compose.yml down -v
```

Your machine is likely faster than the Lightsail box, even with the container limited to 2 CPUs. Use local numbers to compare changes with each other, not as a capacity figure.

### Settings

Pass these to k6 with `-e NAME=value`, or put them in `loadtest/k6.env`.

| Setting | Profile | Default |
|---|---|---|
| `PROFILE` | | `ci` (`ci`, `capacity`, `soak`) |
| `DURATION` | ci, soak | `2m`, `60m` |
| `READ_RPS`, `WRITE_RPS`, `LIVE_CONNECTIONS`, `DOC_EDITORS` | ci, soak | ci 40, 5, 40, 5; soak 100, 10, 100, 10 |
| `READ_P95_MS`, `WRITE_P95_MS`, `DOC_SAVE_P95_MS` | ci | 300, 600, 600 |
| `STEPS`, `STEP_SECONDS` | capacity | 10, 60 |
| `MAX_READ_RPS`, `MAX_WRITE_RPS`, `MAX_LIVE_CONNECTIONS`, `MAX_DOC_EDITORS` | capacity | 400, 40, 400, 40 |
| `LIVE_SECONDS` | all | 30 (how long each live connection stays open) |
| `EDIT_SECONDS`, `TYPING_SECONDS`, `PAUSE_SECONDS` | all | 45, 8, 6 (how long each editor stays, and its typing rhythm) |
| `EDITED_DOCS` | all | 5 (how many docs the editors share) |
| `BUSY_DRAWINGS`, `DRAWING_KB`, `BUSY_PAGE_SHARE` | all | 60, 20, 0.1 (the busy page's drawings, their size, and the share of reads that load it; a few seconds of scribbling is 5–30 KB) |
| `MEDIA` | all | `on` (`off` leaves out uploads, recordings and issues with files) |
| `UPLOADS_PER_MIN`, `PLAYERS`, `ISSUES_PER_MIN` | ci, soak | ci 6, 4, 4; soak 3, 3, 2 |
| `MAX_UPLOADS_PER_MIN`, `MAX_PLAYERS`, `MAX_ISSUES_PER_MIN` | capacity | 30, 30, 30 |
| `VIDEO_MB`, `FULLPAGE_MB`, `SCREENSHOT_KB` | all | 20, 4, 300 (recordings can be up to 40 MB) |
| `SEED_MEDIA_COMMENTS` | all | 4 (comments with files made before the test, which are played and made into issues) |
| `MEDIA_P95_MS` | ci | 10000 |
| `SEED_COMMENTS`, `SEED_DOCS` | all | 400, 40 |
