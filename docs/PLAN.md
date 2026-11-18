# Inklayer: Self-Hosted Web Page Annotation Platform (Plan)

## Context
This is a new **open-source** project named **Inklayer**, hosted as a single repository. It is aimed at UX designers, developers, QA and general users.

**Licensing goal:** Inklayer is released under **Apache-2.0**. This is permissive like MIT, and also includes an explicit patent grant. Anyone can use, self-host, modify or sell services on top of it. To keep that true, every dependency must have a permissive licence that allows commercial use (MIT, Apache-2.0, BSD or ISC). Copyleft (GPL/AGPL) and "source-available" licences are not allowed in shipped code. It has three parts:
- A **.NET server**, shipped as a Docker image.
- A **Chrome extension** (Manifest V3) that captures a web page and lets people annotate it: comment on, highlight or draw on specific elements, plus free drawing anywhere.
- A **web viewer**, so people without the extension can view and discuss captured pages.

Every annotation keeps a full history with timestamps. Access is controlled by roles. Sign-in is Google SSO only, so the server never handles passwords. The system must stay fast with hundreds of users at once.

---

## 1. Architecture

```
Chrome Extension (MV3, TypeScript)          Web Viewer (SPA, TypeScript)
  ├─ capture (DOM snapshot + screenshot)       ├─ renders snapshot in sandboxed iframe
  ├─ annotation overlay (live page)            └─ same annotation overlay package
  └─ OAuth2 PKCE login
            │  HTTPS (REST + SignalR WebSocket)
            ▼
┌──────────────── Docker: inklayer-server (.NET 10, ASP.NET Core) ─────────────────┐
│ API (Minimal APIs) │ Auth (Google OIDC + OpenIddict) │ SignalR │ Snapshot host  │
└───────────┬──────────────────────┬───────────────────────────┬──────────────────┘
         SQLite (WAL mode, EF Core)           Blob store (files on the /data volume;
   metadata, annotations, history, audit)     S3-compatible storage optional later):
                                              HTML, assets, screenshots
```

Shipped as a `docker-compose.yml` with a single `server` service. All state (the SQLite database and snapshot files) lives on one `/data` volume, so a backup is a copy of one folder. TLS is handled by the host's reverse proxy, with Caddy or Traefik as the example setup.

**Reference deployment:** an AWS Lightsail $5 instance, with Caddy for automatic HTTPS and Litestream streaming the SQLite database to S3 (`deploy/lightsail/`, `docs/deploy-aws-lightsail.md`). Images are published to GHCR (amd64 and arm64) by the Release workflow.

### Suggested repo layout
```
/server
  Inklayer.Api/               ASP.NET Core host, endpoints, SignalR hubs
  Inklayer.Domain/            entities, permission rules
  Inklayer.Infrastructure/    EF Core, blob storage, snapshot processing
  Inklayer.Tests/
/client
  packages/overlay/           shared annotation engine (TS) – used by extension + viewer
  packages/capture/           DOM serialization (extension only)
  packages/api-client/        generated from OpenAPI
  apps/extension/             MV3 extension (Vite + CRXJS)
  apps/viewer/                web viewer SPA (React or Svelte), served by the .NET host
/deploy
  Dockerfile, docker-compose.yml, Caddyfile example
```

---

## 2. Core design decisions

### 2.1 Capturing "any web page"
The extension captures the page as the user sees it, while logged in, rather than having the server fetch the URL. Server-side fetching cannot reach pages behind a login, on an intranet or on localhost, and those are exactly the pages UX and QA teams need.
- **DOM snapshot** with `rrweb-snapshot` (MIT licence). It serializes the DOM, including shadow DOM, the current state of form inputs, and inlined or linked stylesheets. Canvas content is converted to data URLs.
- **Asset bundling:** the extension's service worker fetches images, fonts and CSS and uploads them. Each asset is stored once, keyed by its SHA-256 hash, so repeated captures of a site take almost no extra storage.
- **Full-page screenshot:** captured with `chrome.debugger` → `Page.captureScreenshot`, or by stitching `captureVisibleTab` images. It is a fallback and a reference for WebGL, video and cross-origin iframes, which can't be serialized.
- **Capture metadata:** URL, title, viewport size, device pixel ratio, user agent and timestamp.
- **Two modes:**
  - **Snapshot mode:** annotate the frozen copy, which becomes the source of truth.
  - **Live mode:** annotate the real page, with annotations stored against the URL and re-anchored on each visit.

**As built (Phase 2):**
- **Own serializer.** The extension uses its own serializer (`client/packages/capture`) instead of `rrweb-snapshot`. rrweb's output is a JSON tree that needs script to rebuild in the viewer, and the snapshot origin runs no page script.
- **What the serializer outputs:** static HTML containing:
  - styles read from the CSSOM, including CSS-in-JS and adopted stylesheets;
  - declarative shadow DOM, including closed shadow roots, reached through `chrome.dom.openOrClosedShadowRoot`;
  - form state, canvases turned into images, and placeholders where iframes were.
- **Resources:** the background worker fetches them with the user's cookies, follows CSS into fonts and `@import`s, and hashes each one.
- **Screenshot:** the visible area only, for now. Full-page screenshots through `chrome.debugger` are deferred to keep the permissions minimal.
- **Same-origin iframes** aren't captured yet; they become placeholders.

### 2.2 Anchoring annotations to elements
Each annotation stores several independent anchors so it survives small DOM changes:
1. a stable CSS selector, preferring `id`, `data-testid` and ARIA attributes, built with a library like `@medv/finder` (MIT)
2. an XPath
3. for text highlights, a text quote with surrounding prefix and suffix, plus a text position (the W3C Web Annotation selector model)
4. the element's bounding box as a fraction of the document, plus the viewport width when captured

When re-anchoring, the overlay tries each anchor in order and marks the annotation **"orphaned"** if none match.

**Free drawing:** strokes are stored as vector points in document coordinates, rendered with `perfect-freehand` (MIT). A stroke can optionally be pinned to an element, in which case its coordinates are stored relative to that element's box. Each stroke records the viewport width so the viewer can warn when the layout differs.

### 2.3 Annotation model and history
- **Annotation types:** `comment`, `highlight`, `drawing`, `rect`, `arrow`, `pin`.
- **Fields on each annotation:** status (`open` / `resolved`), assignee, labels such as bug or design, and severity for QA.
- **Threads:** each annotation has a comment thread with @mentions.
- **History:** a revision table that is never modified, only added to (`AnnotationRevision`: who, when in UTC, a JSON diff, and the action). The UI shows a timeline and can "view page as of time T". Deletes are soft deletes.
- **Real-time updates:** SignalR groups per snapshot, so collaborators see changes live. Updates use optimistic concurrency through a version column.

### 2.4 Permissions
- **Hierarchy:** Organization → Project → Snapshot / Page.
- **Roles:**
  - **Owner:** billing, delete org
  - **Admin:** manage members and SSO
  - **Editor:** capture and annotate
  - **Commenter:** comment and annotate
  - **Viewer:** read only
- A role can be granted at the org level and overridden per project.
- **Share links:** signed, can expire, view or comment only, and can optionally require a password.
- **Enforcement:** ASP.NET Core policy-based authorization, with an `IAuthorizationHandler` that checks the resource and role. Every query is filtered by org, using an EF Core global query filter, to stop data leaking between tenants.

### 2.5 Authentication: Google SSO only, no passwords stored
The server never sees, stores or resets a password. Google handles sign-in, 2FA, passkeys and account recovery; users who keep their Google login in 1Password still get autofill.

- **Sign-in to Google:** `Microsoft.AspNetCore.Authentication.OpenIdConnect`, pointed at Google (`https://accounts.google.com`). Request only the `openid email profile` scopes. These count as non-sensitive, so Google's consent-screen verification is light.
- **Local user record:** only Google's `sub` (unique user ID), email, name and avatar. No password hash, and no ASP.NET Core Identity password features.
- **Who gets in:**
  - Admins can restrict sign-in to their Google Workspace domain(s) using the `hd` claim.
  - Anyone else needs an invite, matched on verified email (`email_verified=true`).
  - First sign-in from an allowed domain auto-creates the user with the org's default role.
- **Sessions:**
  - **Web viewer:** a secure, HttpOnly, SameSite cookie issued after the Google callback.
  - **Extension:** the server brokers the login with OpenIddict (Apache-2.0). The extension calls `chrome.identity.launchWebAuthFlow` against the server's `/connect/authorize`, the server redirects to Google, and then the server issues its *own* short-lived access token and a rotating refresh token (Authorization Code + PKCE). This keeps Google tokens off the client and lets the server revoke access instantly.
- **Hardening:**
  - validate ID-token issuer, audience and nonce (handled by the OIDC handler)
  - rate limiting with `Microsoft.AspNetCore.RateLimiting`
  - an audit log of sign-ins
  - Data Protection keys kept on a volume that survives container restarts
  - an admin "revoke sessions" action
- **As built (Phase 1):**
  - Instance administrators can create organisations, and they act as Owner in every organisation.
  - Signing and Data Protection keys are stored in `/data/keys`.
  - Tenant isolation is enforced by an `AccessService` check on every endpoint, which returns 404 to non-members, plus explicit `OrganizationId` filters, rather than an EF global query filter. A global filter needs a single "current org" per request, and requests like `/api/me` span several organisations.
- **Later, if needed:** add Microsoft Entra ID or a generic OIDC provider using the same handler with no password code. This is just another provider entry in config.

### 2.6 Securely serving stored pages (critical)
Captured HTML is untrusted, so it could run scripts against the app's users. Snapshots are therefore served:
- from a **separate origin** (for example `snapshots.example.com`, configured by the customer), so they can't reach app cookies;
- with **all scripts removed** at capture time and again on the server, using a sanitizer such as AngleSharp-based HtmlSanitizer, set up to keep styles;
- with `Content-Security-Policy: sandbox; script-src 'none'`;
- inside an `<iframe sandbox>` in the viewer, with the overlay talking to it through `postMessage`;
- through signed, short-lived URLs, so access control still applies.

**As built (Phase 2):**
- **Serving:** `Inklayer:Snapshots:Origin` (e.g. `snapshots.example.com`) serves only `/s/{id}/{token}/` and `/s/{id}/{token}/a/{sha256}`. The app host never serves captured HTML.
- **Policy:** the CSP is `default-src 'none'`, `script-src 'none'`, `sandbox`, with `frame-ancestors` limited to the app origin.
- **Sanitizer:** built on AngleSharp (MIT) rather than HtmlSanitizer. Its rules are structural, which keeps CSS intact, and it has an XSS test corpus.
- **Phase 3 change needed:** the overlay will need its own script inside the frame. That means switching to a per-response `script-src 'nonce-…'` for Inklayer's overlay script only, and `sandbox allow-scripts`, still without `allow-same-origin`.
- **Not done yet:** a blob store that removes files no snapshot uses any more, and per-organisation storage quotas.

### 2.7 Performance for hundreds of users
- A single node handles this comfortably. SQLite runs in WAL mode, so readers never block and writes (small annotation rows) take a few milliseconds. `busy_timeout` queues writers that arrive at the same moment instead of failing them.
- **Single replica only.** SQLite allows one writer process, and the volume must be local disk (not NFS/SMB). This is the deliberate trade-off for zero-dependency hosting. If horizontal scaling is ever needed, EF Core makes switching the provider to PostgreSQL a contained change.
- Snapshot HTML and assets have content-hash URLs, so they get `Cache-Control: immutable` and can sit behind a CDN or the reverse proxy cache.
- Annotations load per snapshot in one paged query, with indexes on `(SnapshotId, CreatedAt)`.
- Uploads are chunked and limited in size. Asset processing runs in a background queue (`Channel<T>` / `BackgroundService`).
- Load testing uses k6: 500 virtual users across REST and WebSocket, with targets of p95 < 200 ms for the API and < 2 s to render a snapshot.

---

## 3. Delivery phases

| Phase | Scope |
|---|---|
| **0. Foundations** | Repo layout and CI (GitHub Actions: build, test, Docker image). SQLite (WAL) and EF migrations, OpenAPI, health checks, Serilog and OpenTelemetry. |
| **1. Auth and tenancy** | Google OIDC sign-in, OpenIddict token broker for the extension, domain allow-list and invites, bootstrap admin, org/project/membership/roles, the authorization handlers, the audit log. |
| **2. Capture** | Extension popup, login, rrweb snapshot, asset upload with deduplication, screenshot, snapshot list in the viewer. Server-side sanitization and the separate snapshot origin. |
| **3. Annotation core** | Shared overlay package: element picker, highlight, comment pins, rectangles and arrows, free drawing. Multi-anchor storage and re-anchoring. |
| **4. Collaboration and history** | Threads, mentions, resolve and assign, revision timeline, "as of" view, SignalR live sync, email notifications. |
| **5. Live mode and extras** | Annotating live pages, comparing snapshots, exporting (PDF/PNG, CSV, Jira/GitHub issue webhooks), share links. |
| **6. Release readiness** | Admin settings UI, backup/restore docs, k6 load tests, security review, Chrome Web Store submission, public docs site, CONTRIBUTING/SECURITY.md, tagged GHCR images. |

---

## 4. Problems and risks

1. **Capture accuracy is never 100%.**
   - Cross-origin iframes, canvas/WebGL, `<video>`, closed shadow roots, lazy-loaded content that hasn't loaded yet, and CSS that depends on JavaScript state can all render wrong.
   - *Mitigation:* the screenshot fallback, an "auto-scroll before capture" option, and showing users a warning on the capture.
2. **Anchors drift.**
   - On responsive layouts and in live mode, page DOM changes can detach annotations from their elements.
   - *Mitigation:* the multiple anchors and "orphaned" state described in 2.2, and preferring `data-testid` attributes, which developers can add.
3. **Stored HTML is an XSS risk.** See 2.6. This is the biggest security risk in the product; get it wrong and every customer's users are exposed.
4. **Google-only sign-in.**
   - **No Google account, no access.** Users at companies on Microsoft 365 need a Google account, which can be a free one tied to their work email. Adding Entra ID later fixes this.
   - **Each self-hosted install needs its own Google OAuth client.** The customer creates a client ID and secret in Google Cloud Console and registers their redirect URI. This is a setup step to document clearly; a central client can't work because redirect URIs are per domain.
   - **Admin lockout.** If an org's only admin loses their Google account, nobody can manage the org. Provide a CLI or environment-variable "bootstrap admin" email for recovery.
   - **Offboarding.** Removing someone from Google Workspace doesn't end their existing session. Keep access tokens short-lived, and re-check the user on every token refresh.
5. **Licensing traps (keeping the project permissive).**
   - **Avoid these:**
     - **SingleFile is AGPL.** Use rrweb-snapshot (MIT) instead.
     - **Duende IdentityServer is source-available and paid.** Use OpenIddict (Apache-2.0).
     - **MinIO is AGPL.** Don't bundle it in the compose file; use a local volume by default, with any S3 endpoint as an option. SeaweedFS (Apache-2.0) also works if you want a bundled object store.
     - **Some popular .NET libraries switched to commercial licences:** MediatR, AutoMapper and MassTransit v9+ (with FluentAssertions v8+ for tests), plus ImageSharp (Six Labors split licence). Don't use them; they aren't needed anyway.
     - **Redis 7.4+ is not open source** (RSAL/SSPL, now AGPL in v8). It isn't needed with a single SQLite node; if a cache or backplane is ever added, use **Valkey** (BSD).
   - **Chosen dependencies (all permissive):**
     - **Server:** ASP.NET Core and EF Core (MIT), Microsoft.Data.Sqlite (MIT) with SQLitePCLRaw (Apache-2.0) and SQLite (public domain), OpenIddict (Apache-2.0), HtmlSanitizer/AngleSharp (MIT), Serilog (Apache-2.0), OpenTelemetry (Apache-2.0)
     - **Client:** rrweb-snapshot, perfect-freehand, @medv/finder, React and Vite (all MIT)
     - **Tests:** xUnit (Apache-2.0), Playwright (Apache-2.0)
   - **Enforce it in CI:** fail the build if a disallowed licence appears. Use `nuget-license` for .NET and `license-checker --onlyAllow "MIT;Apache-2.0;BSD-2-Clause;BSD-3-Clause;ISC;0BSD"` for npm.
   - **Contributions:** use a DCO sign-off (no CLA), so the licensing stays clear.
   - **Name:** "Inklayer" isn't trademark-checked. Search before publishing to GitHub, npm and the Chrome Web Store.
6. **Legal and privacy.**
   - Captures may contain personal data or confidential information from logged-in sessions.
   - Storing third-party pages can raise copyright or terms-of-service questions.
   - *Needed in the software:* retention policies, a way to purge data, and a "mask inputs / mask selectors" option at capture time (rrweb supports this).
   - Whoever hosts an instance is responsible for GDPR in their deployment. The project's job is to provide the tools above and document them.
   - The Chrome Web Store listing needs a privacy policy stating that data only goes to the server the user configures.
7. **Chrome Web Store review.**
   - Broad permissions (`<all_urls>`, `debugger`) slow down review and alarm users.
   - *Mitigation:* use `activeTab` plus optional host permissions where possible, and only request `debugger` when the user takes a full-page screenshot.
   - Enterprises may also need to self-distribute the extension through a policy-managed install.
8. **MV3 constraints.**
   - The background service worker can be shut down mid-task, which can break a long upload.
   - *Mitigation:* resumable chunked uploads, and keeping state in `chrome.storage`.
9. **Pages fight the overlay.**
   - Their CSS and z-index can interfere with the drawing layer.
   - *Mitigation:* render the overlay inside a closed shadow root at the maximum z-index.
10. **SQLite limits.**
    - Only one server replica, and the database must be on local disk. A write lock is held per transaction, so long write transactions (for example a bulk import) must be kept short or batched.
    - *Backups:* use `VACUUM INTO` or the SQLite backup API while the server runs. Copying the `.db` file mid-write can capture a corrupt state. Ship an admin "backup now" endpoint and CLI.
11. **Storage growth.**
    - Snapshots plus screenshots take roughly 2–20 MB each.
    - *Mitigation:* deduplicate by hash, compress with Brotli, and add a retention policy and per-org quotas.
12. **Self-hosted operations.**
    - Customers need backup and restore, upgrades and migrations, and key persistence.
    - *Mitigation:* document these, apply migrations automatically on startup with a guard, and version the image tags.
13. **Firefox and Safari** are out of scope at first. The overlay package is browser-agnostic, so supporting them later mainly means porting the extension shell.

---

## 5. Open decisions (defaults assumed)
- **Viewer front-end:** React, chosen for the larger ecosystem. Svelte would also work.
- **Project licence:** Apache-2.0. MIT is the alternative if you prefer the shortest licence.
- **Live mode:** whether it's needed in v1. Recommended for phase 5, with snapshot mode first.

---

## 6. Verification
- **Unit tests:** xUnit for the authorization handlers and the snapshot sanitizer, including an XSS payload corpus. Vitest for anchoring and re-anchoring.
- **Integration tests:** `WebApplicationFactory` with a throwaway SQLite file per test group, covering auth flows, permission isolation between tenants, and the revision history.
- **End-to-end tests:** Playwright loads the unpacked extension and runs a suite of test sites (an SPA, a site using shadow DOM, a page behind a login, an iframe-heavy page). Each test captures, annotates, reloads, and checks that the annotations re-anchor.
- **Security:**
  - OWASP ZAP scan
  - manual check that snapshot scripts can't run and can't reach app cookies
  - dependency licence audit
- **Load:** k6 at 500 concurrent users with WebSocket fan-out. Watch p95 latency and memory in the OpenTelemetry dashboards.
- **Auth:** integration tests with a fake OIDC provider (the domain allow-list rejects outsiders; an invited email gets in; a revoked user's refresh fails). A manual test signs in with a real Google Workspace account from both the viewer and the extension.
- **Deployment:** `docker compose up` on a clean VM with a Google client ID and secret in env, then sign in with Google, then capture a page and annotate it.
