# Inklayer

**[inklayer.online](https://inklayer.online)**: see every feature in action, and try the extension on the page.

Open-source, self-hosted web page annotation for UX designers, developers and QA.

Comment on any web page, right on the page, with the browser extension (Chrome or Firefox): pin comments, highlight text or draw, attached to specific elements or freehand. Everyone in the project who has the extension sees them on the page. Every change is kept with a full history and timestamps. Access is controlled by roles, and sign-in uses Google or your own SSO provider (JumpCloud, Okta, Entra ID or any OpenID Connect provider).

## Components

| Path | What it is |
|---|---|
| `server/` | ASP.NET Core (.NET 10) API and auth |
| `client/apps/extension/` | Browser extension (Manifest V3, Chrome and Firefox) that shows and adds comments on pages |
| `client/apps/viewer/` | Web app: organisations, members, projects and their commented pages (React) |
| `client/packages/overlay/` | Annotation overlay drawn on pages: anchoring, drawing tools, and the small DOM helpers the extension and site share |
| `client/packages/docs/` | Docs core shared by the viewer and the site: Markdown rendering, the live editor, formatting |
| `client/packages/ui/` | The theme and shadcn components |
| `client/apps/site/` | The showcase at [inklayer.online](https://inklayer.online), built on the overlay package (`pnpm build:site`) |
| `deploy/` | Dockerfile, docker-compose, reverse-proxy examples |

## Self-hosting

```bash
cd deploy
docker compose up -d          # serves on http://localhost:8080
```

All data (a SQLite database) lives on the `inklayer-data` volume. Run a single replica on local disk, and put a TLS reverse proxy in front (see `deploy/Caddyfile.example`).

**Production on AWS for about $7/month:** see [docs/deploy-aws-lightsail.md](docs/deploy-aws-lightsail.md). It covers Lightsail with Caddy HTTPS and Litestream backups to S3. To find out how much load that box can take, see [docs/load-testing.md](docs/load-testing.md).

## Development

Requires the .NET 10 SDK.

```bash
cd server
dotnet test                                  # unit + integration tests
dotnet run --project src/Inklayer.Api        # app on http://localhost:5048 (data in server/.data/)
```

Build the web app into the server's `wwwroot` first (once, or after client changes):

```bash
cd client && pnpm install && pnpm build
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

Requires Node.js 26 (LTS; `client/.nvmrc`) and pnpm (`npm install -g pnpm@<version>`, with the version in `client/package.json` under `engines.pnpm`).

```bash
cd client
pnpm install
pnpm lint            # Biome: lint and formatting (pnpm format fixes what it can)
pnpm typecheck
pnpm test            # unit tests, plus architecture tests (client/test/) that check the code's structure
pnpm build           # Chrome: client/apps/extension/dist, Firefox: client/apps/extension/dist-firefox
```

To install it:
1. **Load it.**
   - **Chrome** (120 or later): open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose `client/apps/extension/dist`.
   - **Firefox** (128 or later): open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on**, and choose `client/apps/extension/dist-firefox/manifest.json`. Temporary add-ons are removed when Firefox closes; a permanent install needs the add-on signed by addons.mozilla.org.
2. **Connect it.** Open the extension popup, enter your server address, and grant site access. Site access is how it reaches your server and shows comments on the pages you visit.
3. **Sign in.**

The server always allows the official extension's sign-in addresses, so there's nothing to configure. They're fixed: in Chrome `https://cihhaaceflhcncmeoiembekghkhbgfio.chromiumapp.org/` (the manifest's `key` pins the ID, for Web Store installs and builds from source alike), in Firefox `https://01fc551d14085f05b25b6448f79709265f7c52ab.extensions.allizom.org/` (from the add-on ID). Only if you build the extension with a different ID (a fork), add its address to `Inklayer:Auth:ExtensionRedirectUris` (`INKLAYER_EXTENSION_REDIRECT_URIS` in Docker), comma-separated.

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
  - **AI assistants (MCP)** use the same kind of tokens, issued only for the MCP endpoint and only after the person allows the app (see below).
- **Revocation:** disabling a user or "sign out everywhere" ends every cookie and token immediately.
- **Network access (VPN), optional:** instance administrators can limit the whole server, including the viewer, the API, sign-in and the extension, to certain networks such as the company VPN. They manage the list under **Admin → Network access**.
  - **Format:** addresses or CIDR ranges, IPv4 or IPv6. An empty list allows every network. Requests from elsewhere get a 403 that shows the caller's address.
  - **Starting list:** set `INKLAYER_ALLOWED_NETWORKS` (e.g. `10.8.0.0/16, 203.0.113.7`) to start with a list. Once an administrator saves a list, it replaces this one.
  - **Lockout protection:** an administrator can't save a list that leaves out their own address. If everyone is locked out anyway, set `INKLAYER_NETWORK_RESTRICTION_DISABLED=true`, restart, fix the list, then remove it.
  - **Always allowed:** health checks (`/health/*`) and the server itself (loopback).
  - **Behind a reverse proxy:** the proxy's network must be in `ForwardedHeaders:KnownNetworks` (`INKLAYER_TRUSTED_PROXY_NETWORK` in the compose file; the Lightsail compose file sets it), or every request appears to come from the proxy over plain HTTP. The server logs a warning when that happens, and the Admin page shows "Your address" as the server sees it, so you can check. Only the proxy should reach the server: don't publish port 8080 to the internet.

### Bug context
When someone saves a comment, the extension attaches what a developer needs to reproduce the problem:
- a screenshot of the area around the comment (the page and its marks, not the Inklayer panel);
- the browser, OS, window size and pixel ratio;
- the element's selector and HTML, with anything typed into forms left out;
- the page's last console errors and warnings, and its failed requests. Addresses are kept without their query strings.

How the console and network details are kept:
- A small script in each page keeps only the last 20 errors and failed requests.
- They stay in the page's memory, and are sent only when someone saves a comment.

People can untick "Attach screenshot and page details" for a comment, and administrators can turn the feature off.

The details show in the extension, in the web app, and to AI assistants through MCP:
- `list_open_comments` lists the open comments in a project, optionally on one page, with their details.
- `get_comment_screenshot` returns the screenshot as an image, so an assistant can see the problem it's fixing.

### Mentions and notifications
Type `@` in a comment, reply or doc to mention someone in the organisation. People are suggested by the name they chose or their real name.

Everyone gets in-app notifications: a bell in the web app, and a count on the extension's toolbar icon. They hear about:
- being mentioned in a comment, reply or doc;
- replies in a thread they're in;
- their comment being resolved;
- an issue linked to their comment being closed.

Organisation Admins can add as many integrations as they like under the organisation's **Integrations** tab:

| Integration | What it does |
|---|---|
| **Email** | Emails people their own notifications. The server needs SMTP settings (`INKLAYER_SMTP_HOST`, `_PORT`, `_USERNAME`, `_PASSWORD`, `_FROM`; Amazon SES works). Each person can turn emails off in Settings. |
| **Slack** | Posts to a channel through an incoming webhook. You choose the events (new comments, mentions, replies, resolved, issues) and, optionally, one project. |
| **Webhook** | Posts JSON to any https address, signed with `X-Inklayer-Signature: sha256=…` (HMAC-SHA256 of the body with the secret shown when you add it). Use it for Teams, Discord or your own tools. |

Messages wait in an outbox and are retried with growing gaps, up to 8 tries. The last error shows on the integration. Webhook addresses and secrets are stored encrypted.

Step-by-step setup for each, including Discord and Teams: [docs/integrations.md](docs/integrations.md#notifications).

### Issue trackers
Project Admins connect trackers under the project's **Settings** tab, as many as they like:

| Tracker | What it needs |
|---|---|
| **GitHub** | The repository owner and name, and a fine-grained personal access token with **Issues: read and write** on it. GitHub Enterprise works too: give its API address. |
| **GitLab** | The project's path (`group/project`) and an access token with the `api` scope and at least the Reporter role. Self-managed GitLab works too: give its address. |
| **Codeberg, Forgejo, Gitea** | The repository owner and name, and an access token with **issue: Read and write** and **repository: Read**. Codeberg by default; give the address of your own Forgejo or Gitea. |
| **Jira Cloud** | The site (`https://<you>.atlassian.net`), project key, issue type (Bug by default), and an Atlassian API token with its account email. |
| **Linear** | The team id and a personal API key. |
| **Azure DevOps** | The organisation address (`https://dev.azure.com/<org>`, or an Azure DevOps Server collection), the project, the work item type (Bug by default), and a personal access token with **Work Items: Read & write**. |

Step-by-step setup for each tracker: [docs/integrations.md](docs/integrations.md#issue-trackers).

How it works:
- **Connecting:** Inklayer checks the credentials before saving them. Tokens are stored encrypted, and only their last four characters are shown again.
- **Creating issues:** Commenters and above choose **Create issue** on a comment, in the extension or on the comment's page. The issue gets the comment, its replies, the page address, a link back to the comment, and the page details (browser, window size, console errors, failed requests). The issue then shows on the comment.
- **Linking existing issues:** instead of creating one, choose **Link existing issue** and search the tracker's open issues, or paste the issue's address or number. Inklayer can add the comment to the issue as a note.
- **Your own account:** people can connect their own GitHub, GitLab, Codeberg/Forgejo, Jira, Linear and Azure DevOps accounts (home page → **Tracker accounts**), so the issues, replies and closes they make from Inklayer show as them. The connection's token becomes an optional shared fallback. The server needs an OAuth app per tracker: [setup](docs/integrations.md#your-own-tracker-account).
- **Comments both ways:** comments written on a linked issue in the tracker show in the Inklayer thread, and notify the people in it. Replies written in Inklayer are posted to the issue too, if the connection is set to.
- **Closing:** resolving a comment closes its issues, unless the connection is set to leave them open. An issue linked to several comments closes when the last of them is resolved.
- **Keeping in step:** trackers can't reach a server behind the VPN, so Inklayer asks them every 5 minutes instead. An issue closed in the tracker resolves its comment, with a reply saying so, and notifies the comment's author and the person who created the issue. An issue reopened there reopens the comment.

### Sharing read-only links
People without an account can read comments and docs through a link, even from outside your network:

| What | Who can share | Where |
|---|---|---|
| **A page's comments** | Commenters and above in the project | **Share this page** (link icon) in the extension's panel. Open comments only; the link lasts 30 days. |
| **A project's comments** | Commenters and above in the project | The project's **Sharing** tab. Choose whether to include resolved comments, and when the link expires. |
| **A doc** | Commenters and above in the organisation | **Make public** in the doc's header. One link per doc; **Make private** turns it off. |

What guests see:
- **Comments:** names, comments, replies and screenshots. No email addresses, roles, page details, issues or links into the app.
- **Docs:** the text, with mentions as names. `[[Links]]` lead to other public docs and are plain text otherwise; comment embeds and tags aren't shown.

Safety:
- **Links:** long random tokens, stored hashed (and encrypted, so people who can see a link can copy it again). Turning a link off stops it at once, and every view is counted.
- **Who manages them:** the project's Sharing tab lists its links; whoever made a link, or a project Admin, can turn it off. Instance administrators see every working link under **Admin → Shared links**.
- **Requests:** share pages and their API aren't indexed by search engines, send no referrer, and are limited to 60 requests a minute per address (`Inklayer:Sharing:PublicRequestsPerMinute`).
- **Network:** with the network allow list on, only `/s/…` (share pages), `/api/public/…` (their API) and `/assets/…` (the app's scripts and styles) are reachable from outside it, and only while Sharing is on. Turning **Sharing** off under **Admin → Features** stops every link and closes that way in.

### Turning features on and off
Instance administrators can turn these features off for everyone under **Admin → Features**:
- **Docs:** the knowledge base, the graph, live doc editing, and `[[links]]` between comments and docs.
- **Live cursors:** cursors, selections and avatars on web pages and in docs.
- **AI assistants (MCP):** the MCP endpoint and app sign-in.

Page comments are always on.

Turning a feature off takes effect straight away:
- The web app and the extension hide it.
- Its addresses answer 404 "turned off".
- Its live connections are closed.

Nothing is deleted, and turning it back on brings everything back.

To start with features off, set them when the server starts. These are starting values: an administrator's choice in the Admin panel wins.

| Feature | Docker Compose (`.env`) | Configuration / command line |
|---|---|---|
| Docs | `INKLAYER_FEATURE_DOCS=false` | `Inklayer:Features:Docs=false` |
| Live cursors | `INKLAYER_FEATURE_LIVE_CURSORS=false` | `Inklayer:Features:LiveCursors=false` |
| AI assistants | `INKLAYER_FEATURE_MCP=false` | `Inklayer:Features:Mcp=false` |
| Bug context | `INKLAYER_FEATURE_BUG_CONTEXT=false` | `Inklayer:Features:BugContext=false` |
| Issue trackers | `INKLAYER_FEATURE_ISSUE_TRACKERS=false` | `Inklayer:Features:IssueTrackers=false` |
| Sharing | `INKLAYER_FEATURE_SHARING=false` | `Inklayer:Features:Sharing=false` |

For example, `dotnet Inklayer.Api.dll --Inklayer:Features:Mcp=false`, or the environment variable `Inklayer__Features__Mcp=false`.

### Improving comments with Claude

The comment box can have an **Improve** button that rewrites a rough draft ("button broke") into a clear comment the team can act on. It keeps your meaning, @mentions, [[doc links]] and #tags. It uses the [Claude Code](https://claude.com/claude-code) CLI already signed in on your computer, so it runs on your own Claude plan. The draft goes from the browser to Claude Code and back into the box, and nothing reaches the Inklayer server until you click Save. **Undo** puts your words back.

It's off by default, and works in Chromium browsers (Chrome, Edge, Brave) on Linux, macOS and Windows. Each person needs [Claude Code](https://claude.com/claude-code) (signed in) and Node.js, and sets it up once:

1. In the extension popup, open **Settings** and click **Improve comments with Claude**. Allow the permission it asks for.
2. Set up the helper, one of these ways (the popup shows both, filled in for your server):
   - **With Claude Code:** run `claude plugin marketplace add KanyeS/inklayer && claude plugin install inklayer@inklayer --config server_url=https://<your server>`, then restart Claude Code. The [plugin](claude-plugin/README.md) registers the helper with your browsers each time Claude Code starts, and also brings the review helper below.
   - **With an installer:** click **Download installer** and open it. On a Mac it's a zip with the installer in it; on Windows a `.cmd`; on Linux a `.sh` you run with `sh`. They aren't signed, so macOS and Windows warn before opening them.
3. Click **Check again**. The popup says **Ready** once it finds the helper.

From a copy of this repository, `node claude-plugin/improve/install.cjs` does the same as the installers. See [claude-plugin/improve/README.md](claude-plugin/improve/README.md) for what the helper runs, and how to remove it.

### Reviewing pages with Claude

Claude Code can try a page or feature in a real browser and leave Inklayer comments on what it finds, as you. Each comment is anchored to the element it's about, with a screenshot of it, the page's details (console errors, failed requests) and, if Claude recorded the steps, a video.

This runs on your computer through the review helper in [client/apps/review](client/apps/review/README.md), a small MCP server that drives Playwright's Chromium. It uses Claude Code's own plan. It signs in to Inklayer as a built-in app ("Inklayer review helper"): your browser opens the first time, and you allow it once. It's listed under **Connected apps**, where you can disconnect it.

To set it up, install Inklayer's Claude Code plugin (the same one as for **Improve** above), then restart Claude Code:

```sh
claude plugin marketplace add KanyeS/inklayer && claude plugin install inklayer@inklayer --config server_url=https://<your server>
npx -y playwright-core@1.65.1 install chromium   # once: the browser the helper drives
```

The viewer's **Connected apps** section has these filled in for your server.

Then ask Claude Code to review a page, for example "review the settings page on staging and comment on anything broken". The plugin's `review-feature` skill tells it how. For sites that need a login, Claude opens a window for you to sign in once, and remembers the sign-in. Claude never sees the password.

### Using Inklayer from Claude (MCP)
Inklayer is an MCP server at `https://<your server>/api/mcp`. An assistant signs in as you and can do what your role allows:
- **Read:** comments and replies on a page, pages with comments, docs (search, read, links and backlinks), tags, history and activity.
- **Write:** reply to, resolve and edit comments, create issues from comments in a connected tracker or link existing ones, and create, edit, rename, move and delete docs. Doc edits appear live to anyone editing the doc in the browser.

To connect (the home page's **Connected apps** section has these filled in for your server, with copy buttons):
- **Claude Code:** run `claude mcp add --transport http inklayer https://<your server>/api/mcp`, then `/mcp` to sign in.
- **Claude Code, signing in on start:** with Node.js installed, run `claude mcp add inklayer -- npx -y mcp-remote https://<your server>/api/mcp --static-oauth-client-metadata '{"token_endpoint_auth_method":"none"}'`. It opens the browser to sign in the first time Claude Code starts. The flag is needed because Inklayer only registers public (PKCE) clients.
- **VS Code or Cursor:** use **Add to VS Code** or **Add to Cursor** under Connected apps. The editor opens the browser to sign in.
- **Claude Desktop or claude.ai:** add a custom connector with the same address.

More detail: [docs/integrations.md](docs/integrations.md#ai-assistants-mcp).

How sign-in works:
- **Signing in:** the app registers itself (OAuth dynamic client registration), your browser opens, you sign in as usual, and Inklayer asks whether to allow the app. You're asked once per app.
- **Disconnecting:** connected apps are listed on the viewer's home page, where you can disconnect them.
- **Token scope:** apps that register themselves only get tokens for MCP: they must ask for `/api/mcp` as the resource, and those tokens only work there. The rest of the API refuses them.
- **Network access:** clients that run on your machine, like Claude Code, work through the VPN. claude.ai and Claude Desktop connectors reach the server from Anthropic's cloud, so they can't connect while the network allow list is on.

Licence check: `dotnet tool restore && dotnet nuget-license -i Inklayer.slnx -t -a ../.github/licenses/allowed-licenses.json -override ../.github/licenses/nuget-overrides.json`

## Licence

[Apache-2.0](LICENSE). Every dependency must use a permissive licence that allows commercial use (MIT, Apache-2.0, BSD, ISC). CI enforces this. See [CONTRIBUTING.md](CONTRIBUTING.md).
