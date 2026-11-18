# Inklayer

Open-source, self-hosted web page annotation for UX designers, developers and QA.

Comment on any web page, right on the page, with the browser extension (Chrome or Firefox): pin comments, highlight text or draw, attached to specific elements or freehand. Everyone in the project who has the extension sees them on the page. Every change is kept with a full history and timestamps. Access is controlled by roles, and sign-in uses Google or your own SSO provider (JumpCloud, Okta, Entra ID or any OpenID Connect provider).

> **Status:** early development. Nothing is usable yet. See [docs/PLAN.md](docs/PLAN.md) for the design and roadmap.

## Components

| Path | What it is |
|---|---|
| `server/` | ASP.NET Core (.NET 10) API and auth |
| `client/apps/extension/` | Browser extension (Manifest V3, Chrome and Firefox) that shows and adds comments on pages |
| `client/apps/viewer/` | Web app: organisations, members, projects and their commented pages (React) |
| `client/packages/overlay/` | Annotation overlay drawn on pages: anchoring, drawing tools |
| `deploy/` | Dockerfile, docker-compose, reverse-proxy examples |

## Self-hosting

```bash
cd deploy
docker compose up -d          # serves on http://localhost:8080
```

All data (a SQLite database) lives on the `inklayer-data` volume. Run a single replica on local disk, and put a TLS reverse proxy in front (see `deploy/Caddyfile.example`).

**Production on AWS for about $7/month:** see [docs/deploy-aws-lightsail.md](docs/deploy-aws-lightsail.md). It covers Lightsail with Caddy HTTPS and continuous Litestream backups to S3.

## Development

Requires the .NET 10 SDK.

```bash
cd server
dotnet test                                  # unit + integration tests
dotnet run --project src/Inklayer.Api        # app on http://localhost:5048 (data in server/.data/)
```

Build the web app into the server's `wwwroot` first (once, or after client changes):

```bash
cd client && npm ci && npm run build
```

To sign in locally, create a Google OAuth client (type "Web application") with redirect URI `http://localhost:5048/auth/callback/google`, then:

```bash
cd server/src/Inklayer.Api
dotnet user-secrets set "Inklayer:Auth:Google:ClientId" "<client id>"
dotnet user-secrets set "Inklayer:Auth:Google:ClientSecret" "<client secret>"
dotnet user-secrets set "Inklayer:Auth:BootstrapAdmins" "you@gmail.com"
```

To use another OpenID Connect provider instead of, or as well as, Google, see [docs/sso-oidc.md](docs/sso-oidc.md).

Then open <http://localhost:5048/auth/login>.

| Endpoint | Purpose |
|---|---|
| `/health/live`, `/health/ready` | Liveness and readiness |
| `/openapi/v1.json` | OpenAPI document listing every endpoint |
| `/auth/login`, `/auth/logout` | Browser sign-in (`?provider=<id>` picks a provider) and sign-out |
| `/auth/providers` | The sign-in providers configured on the server |
| `/connect/authorize`, `/connect/token` | OAuth 2.0 + PKCE for the browser extension |
| `/api/me` | Current user and their organisations |
| `/api/orgs/...`, `/api/projects/...` | Organisations, members, invitations, projects, per-project roles, audit log |
| `/api/admin/users` | Instance administration |
| `/api/live/...`, `/api/projects/{id}/live/...` | Sites with comments, your projects, and comments on a page |
| `/api/annotations/{id}` | Edit, resolve, delete; `/history` for every revision |
| `/api/activity` | Activity log: comments, plus sign-ins and errors for administrators |

### Browser extension

Requires Node.js 22.

```bash
cd client
npm ci
npm test             # overlay anchoring tests
npm run build        # Chrome: client/apps/extension/dist, Firefox: client/apps/extension/dist-firefox
```

To install it:
1. **Load it.**
   - **Chrome** (120 or later): open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose `client/apps/extension/dist`.
   - **Firefox** (128 or later): open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on**, and choose `client/apps/extension/dist-firefox/manifest.json`. Temporary add-ons are removed when Firefox closes; a permanent install needs the add-on signed by addons.mozilla.org.
2. **Connect it.** Open the extension popup, enter your server address, and grant site access. Site access is how it reaches your server and shows comments on the pages you visit.
3. **Allow its sign-in address.** The popup shows the extension's sign-in address: `https://<extension-id>.chromiumapp.org/` in Chrome, `https://<hash>.extensions.allizom.org/` in Firefox. Add it to the server's `Inklayer:Auth:ExtensionRedirectUris` (`INKLAYER_EXTENSION_REDIRECT_URIS` in Docker). To use both browsers, list both addresses, separated by a comma.
4. **Sign in.**

### Commenting

People with the extension can see and add comments **directly on any website**.

- **See comments.** On a page that has comments in your projects, an **Inklayer** button appears in the bottom-right corner, with the number of open comments.
- **Add comments.** On any page, click the Inklayer toolbar button and choose **Comment on this page**. Pick the project in the panel; Commenters and above can add comments, Viewers can only see them.
- **Which address.** When a page's address has a query string or #hash, the person commenting chooses where the comment belongs: every version of the page (`youtube.com/watch`) or only that exact address (`youtube.com/watch?v=bm33vG-QHvE`). Only the parts they choose are stored, so tracking parameters and tokens stay out unless someone picks them. Each comment shows the address it belongs to.

**Privacy:** the extension keeps a list of the sites (domains only) that have comments you can see. It only sends the server a page's full address on those sites, or when you choose **Comment on this page**. The server stores only the parts of an address that make a different page. Each project lists its commented pages under **Pages** in the web app.

**Activity log:** the panel's **Activity** tab (or **Activity log** in the toolbar popup) lists recent activity, newest first. It only loads when you open it.

| You are | You see |
|---|---|
| Anyone in a project | Who commented, edited, resolved, reopened or deleted, on which page, in projects you can view. Filter by **This site** or **Everywhere** |
| Organisation Admin or Owner | Also sign-ins by members of your organisations |
| Instance administrator | Also refused sign-ins and server errors (method, path and error; never query strings or request bodies). Errors are kept for 30 days |

**Tools** (in the panel on the page; Viewers see comments but get no tools):

| Tool | What it does |
|---|---|
| Select | Click a mark to find its comment; click a comment to scroll to its mark |
| Pin | Pin a comment to a point on an element |
| Element | Outline a whole element |
| Text | Select text to highlight it |
| Box / Arrow | Drag to draw |
| Draw | Freehand ink (pen pressure supported) |

**How marks stay attached:**
- **Anchors:** each mark is attached to an element through several independent anchors: CSS selectors (shadow DOM aware), XPath, text, and its original position. Shapes are stored relative to that element, so they follow layout changes.
- **Orphans:** if the element can't be found, the mark is shown where it originally was and flagged as "moved" in the list.
- **Changing pages:** marks follow single-page-app navigation and DOM changes.

**Comments:** Commenters and above can annotate and resolve. Authors and project Admins can edit and delete. Every change is versioned (`GET /api/annotations/{id}/history`), and conflicting edits are refused rather than overwritten.

**On the page:** the overlay and panel live in closed shadow roots, so the page's CSS and scripts can't restyle or read them. The page never sees an access token: the extension's background worker makes every API call, checked against the page's real origin.

### How sign-in and access work
- **Single sign-on only.** People sign in with Google or an OpenID Connect provider such as JumpCloud ([setup](docs/sso-oidc.md)). Inklayer stores no passwords.
- **Who can get in:**
  - instance administrators listed in `Inklayer:Auth:BootstrapAdmins`;
  - people with an invitation for their verified email;
  - Google Workspace users, or users of an SSO provider [verified for their domain](docs/sso-oidc.md#verified-domains), whose domain an organisation has allowed. They join automatically with that organisation's default role.
- **Roles:** Viewer < Commenter < Editor < Admin < Owner. Viewers only see comments; Commenters and Editors can add them (Editor is kept for compatibility and currently grants the same as Commenter). A project can raise or lower a Viewer, Commenter or Editor; Admins and Owners keep their role everywhere.
- **Clients:**
  - **The web viewer** uses an HttpOnly session cookie. State-changing requests must send the `X-Inklayer-Csrf` header.
  - **The extension** uses short-lived bearer tokens with rotating refresh tokens.
- **Revocation:** disabling a user or "sign out everywhere" ends every cookie and token immediately.
- **Network access (VPN), optional:** instance administrators can limit the whole server, including the viewer, the API, sign-in and the extension, to certain networks such as the company VPN. They manage the list under **Admin → Network access**.
  - **Format:** addresses or CIDR ranges, IPv4 or IPv6. An empty list allows every network. Requests from elsewhere get a 403 that shows the caller's address.
  - **Starting list:** set `INKLAYER_ALLOWED_NETWORKS` (e.g. `10.8.0.0/16, 203.0.113.7`) to start with a list. Once an administrator saves a list, it replaces this one.
  - **Lockout protection:** an administrator can't save a list that leaves out their own address. If everyone is locked out anyway, set `INKLAYER_NETWORK_RESTRICTION_DISABLED=true`, restart, fix the list, then remove it.
  - **Always allowed:** health checks (`/health/*`) and the server itself (loopback).
  - **Behind a reverse proxy:** the proxy's network must be in `ForwardedHeaders:KnownNetworks` (the Lightsail compose file sets it), or every request appears to come from the proxy. The Admin page shows "Your address" as the server sees it, so you can check.

Licence check: `dotnet tool restore && dotnet nuget-license -i Inklayer.slnx -t -a ../.github/licenses/allowed-licenses.json -override ../.github/licenses/nuget-overrides.json`

## Licence

[Apache-2.0](LICENSE). Every dependency must use a permissive licence that allows commercial use (MIT, Apache-2.0, BSD, ISC). CI enforces this. See [CONTRIBUTING.md](CONTRIBUTING.md).
