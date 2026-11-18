# Inklayer

Open-source, self-hosted web page annotation for UX designers, developers and QA.

Capture any web page with the Chrome extension. Then comment on it, highlight it or draw on it, either on specific elements or freehand. Every change is kept with a full history and timestamps. Access is controlled by roles, and sign-in uses Google SSO.

> **Status:** early development. Nothing is usable yet. See [docs/PLAN.md](docs/PLAN.md) for the design and roadmap.

## Components

| Path | What it is |
|---|---|
| `server/` | ASP.NET Core (.NET 10) API, auth, real-time hub, snapshot host |
| `client/apps/extension/` | Chrome extension (Manifest V3) for capture and annotation |
| `client/apps/viewer/` | Web viewer for captured pages |
| `client/packages/` | Shared TypeScript packages (overlay, capture, API client) |
| `deploy/` | Dockerfile, docker-compose, reverse-proxy examples |

## Self-hosting

```bash
cd deploy
docker compose up -d          # serves on http://localhost:8080
```

All data (the SQLite database and snapshots) lives on the `inklayer-data` volume. Run a single replica on local disk, and put a TLS reverse proxy in front (see `deploy/Caddyfile.example`).

**Production on AWS for about $5/month:** see [docs/deploy-aws-lightsail.md](docs/deploy-aws-lightsail.md). It covers Lightsail with Caddy HTTPS and continuous Litestream backups to S3.

## Development

Requires the .NET 10 SDK.

```bash
cd server
dotnet test                                  # unit + integration tests
dotnet run --project src/Inklayer.Api        # app on http://localhost:5048, captured pages on :5049 (data in server/.data/)
```

To sign in locally, create a Google OAuth client (type "Web application") with redirect URI `http://localhost:5048/auth/callback/google`, then:

```bash
cd server/src/Inklayer.Api
dotnet user-secrets set "Inklayer:Auth:Google:ClientId" "<client id>"
dotnet user-secrets set "Inklayer:Auth:Google:ClientSecret" "<client secret>"
dotnet user-secrets set "Inklayer:Auth:BootstrapAdmins" "you@gmail.com"
```

Then open <http://localhost:5048/auth/login>.

| Endpoint | Purpose |
|---|---|
| `/health/live`, `/health/ready` | Liveness and readiness |
| `/openapi/v1.json` | OpenAPI document listing every endpoint |
| `/auth/login`, `/auth/logout` | Browser sign-in with Google and sign-out |
| `/connect/authorize`, `/connect/token` | OAuth 2.0 + PKCE for the browser extension |
| `/api/me` | Current user and their organisations |
| `/api/orgs/...`, `/api/projects/...` | Organisations, members, invitations, projects, per-project roles, audit log |
| `/api/admin/users` | Instance administration |
| `/api/projects/{id}/blobs/...`, `/api/projects/{id}/snapshots`, `/api/snapshots/{id}` | Capture upload, snapshot list/detail/delete |
| `/s/{snapshotId}/{token}/` (snapshot origin only) | Serves a captured page under a signed, expiring link |

### Browser extension

Requires Node.js 22.

```bash
cd client
npm ci
npm test             # serializer, CSS and resource-resolution tests
npm run build        # outputs client/apps/extension/dist
```

To install it:
1. **Load it.** In Chrome, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose `client/apps/extension/dist`.
2. **Connect it.** Open the extension popup, enter your server address, and grant site access. Site access is how it reaches your server and fetches the images and fonts of pages you capture.
3. **Allow its sign-in address.** The popup shows the extension's sign-in address (`https://<extension-id>.chromiumapp.org/`). Add it to the server's `Inklayer:Auth:ExtensionRedirectUris` (`INKLAYER_EXTENSION_REDIRECT_URIS` in Docker).
4. **Capture.** Sign in with Google, pick a project, and click **Capture this page**.

**What a capture contains:**
- **Static HTML:** the page as you see it, including typed form values, CSS-in-JS styles, shadow DOM and canvases. Password fields are never captured, and a CSS selector in Settings can mask personal data.
- **Assets:** images, fonts and stylesheets, deduplicated by content hash.
- **A screenshot** of the visible area.

The server sanitizes the HTML, then serves it only from the separate snapshot origin under signed, expiring links, with scripts and external loads blocked.

### How sign-in and access work
- **Google only.** Inklayer stores no passwords.
- **Who can get in:**
  - instance administrators listed in `Inklayer:Auth:BootstrapAdmins`;
  - people with an invitation for their verified Google email;
  - Google Workspace users whose domain an organisation has allowed. They join automatically with that organisation's default role.
- **Roles:** Viewer < Commenter < Editor < Admin < Owner. A project can raise or lower a Viewer, Commenter or Editor; Admins and Owners keep their role everywhere.
- **Clients:**
  - **The web viewer** uses an HttpOnly session cookie. State-changing requests must send the `X-Inklayer-Csrf` header.
  - **The extension** uses short-lived bearer tokens with rotating refresh tokens.
- **Revocation:** disabling a user or "sign out everywhere" ends every cookie and token immediately.

Licence check: `dotnet tool restore && dotnet nuget-license -i Inklayer.slnx -t -a ../.github/licenses/allowed-licenses.json -override ../.github/licenses/nuget-overrides.json`

## Licence

[Apache-2.0](LICENSE). Every dependency must use a permissive licence that allows commercial use (MIT, Apache-2.0, BSD, ISC). CI enforces this. See [CONTRIBUTING.md](CONTRIBUTING.md).
