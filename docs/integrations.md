# Setting up integrations

Step-by-step setup for everything Inklayer connects to:

- **[Issue trackers](#issue-trackers)**, per project: [GitHub](#github), [GitLab](#gitlab), [Codeberg, Forgejo and Gitea](#codeberg-forgejo-and-gitea), [Jira Cloud](#jira-cloud), [Linear](#linear), [Azure DevOps](#azure-devops).
- **[Notifications](#notifications)**, per organisation: [Email](#email), [Slack](#slack), [Webhooks](#webhooks) (also Discord and Microsoft Teams).
- **[AI assistants (MCP)](#ai-assistants-mcp)**, per person: Claude Code, Claude Desktop, claude.ai, VS Code, Cursor.

An administrator can turn each of these off for the whole server; see [Turning features on and off](../README.md#turning-features-on-and-off).

## Issue trackers

Project Admins connect trackers in the project's **Settings** tab, under **Issue trackers**. A project can have as many as you like, of any kind. Each connection asks for:
- a **Name**, which commenters see when they choose where an issue goes;
- whether to **close the issue when its comment is resolved** (on by default);
- whether to **post replies written in Inklayer to the issue** (off by default; see [below](#following-an-issues-comments)).

People can act as **their own accounts** instead of a shared token, once the server has an OAuth app for the tracker; see [Your own tracker account](#your-own-tracker-account). Otherwise everything is done as the account whose token the connection has.

Inklayer checks the credentials before it saves them. Tokens are stored encrypted, and only their last four characters are shown again. **Test** on a connection checks it again later, and the connection shows the last error if syncing fails, for example when a token has expired.

Once a tracker is connected, Commenters and above choose **Create issue** on a comment, in the extension or on the comment's page. The comment's first line becomes the issue's title (you can change it when creating the issue in the web app). The issue includes the comment, its replies, the page address, a link back, the page details (browser, window size, console errors, failed requests), and the screenshot.

**Screenshots in issues.** The screenshot, and the full-page screenshot if one was taken, go into the issue:
- **GitLab, Azure DevOps and Linear:** uploaded to the tracker and shown in the issue. The tracker keeps them.
- **Jira and Codeberg/Forgejo/Gitea:** attached to the issue, and listed in it.
- **GitHub**, which can't take files from apps: shown from Inklayer's own copy, at a public address with a long random token, made when the file first goes into an issue. Anyone with the address can open it, the same as anyone who can read the issue. The address stops working when the comment is deleted, and isn't reachable from outside if the server is limited to certain networks.

If an upload fails, the issue is still made, the file is shown from the public address instead, and the tracker shows the error.

**Full-page screenshots.** In the extension, tick **Also a full-page screenshot** under a new comment. Inklayer scrolls through the page and takes it all, top to bottom, with fixed headers shown only once; very long pages are cut off at about 12,000 pixels. It opens from the comment, in the extension and in the web app.

**Recordings.** Under a new comment in the extension, choose **Record the tab…**. A small Inklayer window opens: choose **Start recording**, pick the tab in the browser's share prompt, show what's wrong, then **Stop** (it stops by itself after a minute, and the browser's own "Stop sharing" stops it too). The comment box then says **Recording attached**, and it's sent when you save the comment. Recordings are WebM (MP4 where the browser can't record WebM), at most 40 MB. They play under the comment on the page (**Play recording**), and on the comment's page in the web app. In issues, GitLab plays them inline. The other trackers can't play videos added by apps, so the issue shows a still from the recording with a play symbol, which opens where it plays: Inklayer's page for the comment (GitHub: Inklayer's public copy). The video is also uploaded to Azure DevOps and Linear (with a download link) and attached in Jira and Forgejo; Jira shows a "Play it here" link instead of the still.

**Where files are kept.** Screenshots of the commented area are small and kept in the database. Full-page screenshots (and recordings) are kept in an S3 bucket when the server has one (`MEDIA_S3_BUCKET`), otherwise in `/data/media` on the server, which isn't backed up. People always download them through the Inklayer server, never from S3 directly.

### Linking an issue that already exists

When the problem is already tracked, link the comment to that issue instead of creating a duplicate. Choose **Link existing issue** on the comment's page, or **Link issue** in the extension. Then either:
- **search:** type words from the title, and pick from the tracker's open issues. An empty box lists the most recently updated ones;
- **paste:** give the issue's address, or its number or key (`#12`, `ABC-12`, `ENG-5`).

With **Add this comment to the issue** (on by default), Inklayer posts the comment on the issue as a note: its text, replies, page address, page details and a link back. The note is posted as your own account where you've [connected one](#your-own-tracker-account), otherwise as the connection's token account. Turn it off to link without posting anything.

Several comments can link to the same issue. Closing the issue resolves all of them. Resolving them in Inklayer closes the issue only when the last one is resolved, so one fix doesn't close an issue that still has open reports.

An address from another repository or project is refused, as is a GitHub or Forgejo pull request.

### Choosing the type, and creating an issue under another (Jira and Azure DevOps)

When creating an issue in Jira or Azure DevOps, a small form opens first. In the extension it opens from **Create issue**; in the web app it's part of the **New issue** form.
- **Type:** pick from the project's issue types. The list comes from the tracker as you, so it shows the types you can create. It starts on the tracker's own type. Hidden Azure DevOps types and Jira sub-task types aren't listed.
- **Sub-task of** (Jira) or **Child of** (Azure DevOps), optional: an issue to create this one under. Search by title, or paste the parent's key, number or address.

With a parent:
- **Jira:** under an ordinary issue, it becomes a **sub-task**, in the project's sub-task type (whatever type was picked). Under an **epic**, it becomes an issue of the chosen type in that epic. A sub-task can't be a parent, since Jira doesn't allow sub-tasks of sub-tasks.
- **Azure DevOps:** it becomes a work item of the chosen type, linked as a **child** of the parent.

The parent must be in the same project. Leave it empty for an ordinary issue.

### Pull requests

A comment can be linked to a **pull request** (a **merge request** in GitLab) in GitHub, GitLab, Codeberg/Forgejo/Gitea and Azure DevOps, for feedback a change is meant to fix. Jira and Linear have no pull requests.
- **Linking:** in the extension, **Link issue** → **Pull request**; in the web app, **Link pull request**. Search the open pull requests by title, or paste the address or number (`#12`, or `!12` in GitLab and Azure DevOps). Before you type, the ones linked to comments lately come first, marked **Recent**: yours, then the rest of the project's. Linking issues works the same way. In Azure DevOps, pull requests come from any repository in the tracker's project.
- **Merging resolves the comment**, within about 5 minutes, with a "Merged in …" reply. A pull request closed without merging leaves its comments open. Resolving a comment in Inklayer doesn't close the pull request.
- **The summary on the pull request.** Inklayer keeps one comment on the pull request listing the comments linked to it: each one's state, first line, author and page, its issues, and a link to open it in Inklayer. It's edited as comments are linked, resolved or reopened, and when the pull request is merged. Turn off **List this comment in the pull request's Inklayer summary** to link a comment without listing it. The summary is posted as your [own account](#your-own-tracker-account) where you've connected one, otherwise as the connection's token account. In Azure DevOps it's a closed thread, so it doesn't hold up policies that want comments resolved.
- **On the pull request's page**, the extension shows **Linked to this pull request**, with each comment, its page and its issues. Clicking a comment opens it where it was left. The extension knows which pull requests have comments, and only asks the server about pages that are one.
- **Azure DevOps tokens** need **Code: Read & write** as well as Work Items, for pull requests. Your own connected account already has it.
- A pull request's own conversation stays in the tracker: unlike issues, its comments aren't brought into the Inklayer thread.

### Following an issue's comments

Comments written on a linked issue in the tracker show in the Inklayer thread, mixed in with the replies by time. Each is marked with the issue it came from, such as "on GitHub #12". They are read-only in Inklayer.
- They arrive within about a minute while the comment is open in the extension or the web app, and within about 5 minutes otherwise. Linking an issue brings in its earlier comments straight away (up to 100).
- New ones notify the comment's author, the people who replied, and whoever created or linked the issue.
- Comments are read while the issue is open, and for 14 days after it closes.
- Edits made in the tracker are picked up. Deletions aren't yet: a comment deleted in the tracker stays in Inklayer.
- GitLab's system notes ("changed the description") are left out. Jira and Azure DevOps comments are shown as plain text.

**Posting replies back.** With **Post replies** turned on for a connection (in the project's **Settings → Issue trackers**, or when connecting it), each reply written in Inklayer on a linked comment is also posted on the issue, with a link back. It's posted as its author's [own account](#your-own-tracker-account) where they've connected one. Otherwise it's posted as the connection's token account, as **Name (via Inklayer): reply**, and if the connection has no token the reply stays in Inklayer. Inklayer recognises what it posted and doesn't show it twice. Editing or deleting a reply in Inklayer doesn't change the posted copy.

### Your own tracker account

People can connect their own accounts in GitHub, GitLab, Codeberg/Forgejo/Gitea, Jira, Linear and Azure DevOps, so what they do from Inklayer shows as them in the tracker: the issues they create, the notes added when they link an issue, the replies posted to issues, and issues closed when they resolve a comment. Each tracker needs an OAuth app registered once for the server ([below](#registering-the-oauth-apps)); trackers without one use the connection's token for everything.

**For people:** on the Inklayer home page, under **Tracker accounts**, choose **Connect** next to the tracker and allow Inklayer there. You come straight back. **Create issue** and **Link existing issue** also offer it when it's needed. One connection covers every project. Inklayer renews the access by itself; you only connect again if you take the access back in the tracker. **Disconnect** removes it from Inklayer, and in GitHub, GitLab and Linear also takes back Inklayer's access there. (Elsewhere, remove it in the tracker's own settings: Codeberg **Settings → Applications**, Atlassian **Account settings → Connected apps**, Microsoft **My Apps**.)

**For project Admins:** where people's own accounts work, a connection doesn't need a token. Connect your own account first; Inklayer uses it to check the settings. A **shared token**, such as a bot account's, is then optional: people who haven't connected their own account act as it, and replies posted through it carry the author's name. Without a shared token, they're asked to connect when they create or link an issue, and their replies stay in Inklayer. For Jira without a shared token, the account email isn't needed.

Inklayer checks linked issues every 5 minutes with the shared token if there is one, otherwise with the account of whoever created or linked the issue, otherwise with the account of whoever connected the tracker. Resolving a comment closes its issue as the person who resolved it, falling back the same way.

Which connections use people's own accounts:
- **GitHub:** repositories on github.com (or on the GitHub Enterprise Server the app is registered on).
- **GitLab** and **Codeberg/Forgejo/Gitea:** projects on the one instance the app is registered on (gitlab.com and codeberg.org by default). Connections to other instances use their token.
- **Jira, Linear:** all of them. For Jira, the person must allow Inklayer on that Jira site when connecting.
- **Azure DevOps:** organisations on Azure DevOps Services (`dev.azure.com`) backed by Microsoft Entra ID. Azure DevOps Server, and organisations that only use personal Microsoft accounts, use the token.

#### Registering the OAuth apps

For each tracker you want, register an app, then give its client ID and secret to the server. With the Docker Compose files in `deploy/`, set the variables shown in `.env` and run `docker compose up -d`. The **callback URL** (also called redirect URI) is always:

```
https://<your Inklayer address>/api/me/tracker-accounts/<tracker>/callback
```

with `<tracker>` one of `github`, `gitlab`, `forgejo`, `linear`, `jira`, `azuredevops`.

**GitHub** (`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`)
1. **Settings → Developer settings → OAuth Apps → New OAuth App** ([direct link](https://github.com/settings/applications/new)), or the same under an organisation's settings if a team should manage it.
2. **Application name** `Inklayer`, **Homepage URL** your Inklayer address, **Authorization callback URL** `…/api/me/tracker-accounts/github/callback`.
3. **Register application**, then **Generate a new client secret**.

GitHub OAuth apps can't be limited to one repository: people allow the `repo` scope, which covers every repository they can reach; Inklayer only uses it for the repositories connected to projects. Organisations with **OAuth app access restrictions** (**Settings → Third-party access**) must approve the app first; until then GitHub answers "Not found". For GitHub Enterprise Server, register the app there and also set `Inklayer__Trackers__GitHub__WebUrl` (`https://github.acme.com`) and `Inklayer__Trackers__GitHub__ApiUrl` (`https://github.acme.com/api/v3`).

**GitLab** (`GITLAB_CLIENT_ID`, `GITLAB_CLIENT_SECRET`, and `GITLAB_URL` for a self-managed instance)
1. On gitlab.com: **User settings → Applications → Add new application** ([direct link](https://gitlab.com/-/user_settings/applications)). A group's **Settings → Applications** works too, and a self-managed instance's administrator can add an instance-wide one under **Admin → Applications**.
2. **Name** `Inklayer`, **Redirect URI** `…/api/me/tracker-accounts/gitlab/callback`, **Confidential** ticked, scope **api**.
3. **Save application**, and copy the **Application ID** (the client ID) and **Secret**.

**Codeberg, Forgejo and Gitea** (`FORGEJO_CLIENT_ID`, `FORGEJO_CLIENT_SECRET`, and `FORGEJO_URL` for your own instance)
1. **Settings → Applications → Manage OAuth2 applications** ([Codeberg](https://codeberg.org/user/settings/applications)).
2. **Application name** `Inklayer`, **Redirect URIs** `…/api/me/tracker-accounts/forgejo/callback`, **Confidential client** ticked.
3. **Create application**, and copy the **Client ID** and **Client secret** (shown once).

Forgejo and Gitea don't narrow what an OAuth app can do: people allow access to their account as a whole.

**Linear** (`LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`)
1. In Linear, **Settings → API → OAuth applications → Create new** (you need to be a workspace admin).
2. **Application name** `Inklayer`, **Developer URL** your Inklayer address, **Callback URLs** `…/api/me/tracker-accounts/linear/callback`. Leave **Public** off unless people in other Linear workspaces will use your server.
3. **Create**, and copy the **Client ID** and **Client secret**.

**Jira Cloud** (`ATLASSIAN_CLIENT_ID`, `ATLASSIAN_CLIENT_SECRET`)
1. At [developer.atlassian.com](https://developer.atlassian.com/console/myapps/), **Create → OAuth 2.0 integration**, named `Inklayer`.
2. **Permissions → Jira API → Add**, then **Configure** and add the classic scopes **read:jira-work**, **write:jira-work** and **read:jira-user**. Also add **User identity API** with **read:me**.
3. **Authorization → OAuth 2.0 (3LO) → Configure**, with **Callback URL** `…/api/me/tracker-accounts/jira/callback`.
4. **Settings**: copy the **Client ID** and **Secret**.
5. **Distribution**: while the app is in development, only you can use it. Choose **Edit → Sharing** so people in your organisation can, and fill in the details Atlassian asks for.

When someone connects, Atlassian asks which site to allow Inklayer on: it must be the site in the Jira connection.

**Azure DevOps** (`AZURE_DEVOPS_CLIENT_ID`, `AZURE_DEVOPS_CLIENT_SECRET` or `AZURE_DEVOPS_CERTIFICATE_PATH`, `AZURE_DEVOPS_TENANT_ID`)

Azure DevOps no longer takes new OAuth apps of its own; sign-in goes through Microsoft Entra ID.
1. In the [Azure portal](https://portal.azure.com), **Microsoft Entra ID → App registrations → New registration**.
2. **Name** `Inklayer`. **Supported account types:** *this organisational directory only* if everyone is in your tenant, else *any organisational directory*. **Redirect URI:** platform **Web**, `…/api/me/tracker-accounts/azuredevops/callback`.
3. **Register**, and copy the **Application (client) ID** and the **Directory (tenant) ID**.
4. **Certificates & secrets → New client secret**; copy its **Value** (shown once). Note when it expires: renew it before then. Or use a certificate instead, which is safer ([below](#signing-in-with-a-certificate)).
5. **API permissions → Add a permission → Azure DevOps → Delegated → user_impersonation → Add.** An administrator can **Grant admin consent** so people aren't asked one by one.
6. Set `AZURE_DEVOPS_TENANT_ID` to the tenant ID for a single-tenant app, or leave it as `organizations` for a multi-tenant one.

The Azure DevOps organisation must be connected to that Entra tenant (**Organization settings → Microsoft Entra**).

<a id="signing-in-with-a-certificate"></a>**Signing in with a certificate.** Instead of a client secret, the server can prove who it is with a certificate. Its private key never leaves the server: each token request carries a short-lived proof signed with it, rather than the secret itself.
1. On the server, make a certificate and its key in one file, readable by the server (uid 1654):
   ```bash
   cd /opt/inklayer && sudo mkdir -p certs && cd certs
   sudo openssl req -x509 -newkey rsa:2048 -sha256 -days 730 -nodes -subj "/CN=Inklayer Azure DevOps" -keyout key.pem -out azuredevops.crt
   sudo sh -c 'cat azuredevops.crt key.pem > azuredevops.pem' && sudo rm key.pem
   sudo chown 1654 azuredevops.pem && sudo chmod 400 azuredevops.pem
   ```
2. In the app registration, **Certificates & secrets → Certificates → Upload certificate**, and upload `azuredevops.crt` (only the public part; copy it off the server with `scp`).
3. In `.env`, set `AZURE_DEVOPS_CERTIFICATE_PATH=/certs/azuredevops.pem` (the compose file mounts `./certs` at `/certs`), leave `AZURE_DEVOPS_CLIENT_SECRET` empty, and run `sudo docker compose up -d`.

A `.pfx` works too, with its password in `AZURE_DEVOPS_CERTIFICATE_PASSWORD`. The certificate expires as well (after 730 days above): before then, make a new one, upload it, swap the file and restart the server. If the server can't read the file, connecting Azure DevOps shows why, and people's connected accounts are kept.

### GitHub

With [people's own accounts](#your-own-tracker-account) set up on the server, the token is optional: it's the shared account for people who haven't connected their own. Otherwise, you need a **fine-grained personal access token** that can read and write issues on the repository.

1. On GitHub, open **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token** ([direct link](https://github.com/settings/personal-access-tokens/new)).
2. **Resource owner:** the account or organisation that owns the repository. Some organisations require approval for fine-grained tokens. If yours does, an organisation owner approves the request under the organisation's **Settings → Personal access tokens → Pending requests**.
3. **Expiration:** pick one that suits you, and note the date. When the token expires, issue creation and syncing stop until you replace it.
4. **Repository access:** **Only select repositories**, then choose the repository.
5. **Permissions → Repository permissions → Issues: Read and write.** Nothing else is needed. GitHub adds **Metadata: Read-only** itself.
6. **Generate token** and copy it. GitHub shows it only once.
7. In Inklayer, choose **GitHub** and fill in:

   | Field | Example | Where to find it |
   |---|---|---|
   | Owner | `acme` | The first part of the repository address, `github.com/acme/website` |
   | Repository | `website` | The second part |
   | Token | `github_pat_…` | From step 6 (optional with people's own accounts) |
   | API address | leave empty | Only for **GitHub Enterprise Server**: `https://<your GitHub host>/api/v3` |

The repository must have Issues turned on (**Settings → General → Features → Issues**).

### GitLab

This works with gitlab.com and self-managed GitLab. You need an **access token with the `api` scope**. GitLab has no narrower scope that can write issues.

The token can be either of these:
- **A project access token** (recommended, where your plan offers them). It is limited to one project, and issues are created by a bot user. In the project, open **Settings → Access tokens → Add new token**. Choose the **Reporter** role and the **`api`** scope.
- **A personal access token.** Open **Preferences** (your avatar) **→ Access tokens → Add new token**, with the **`api`** scope. The account needs at least the **Reporter** role in the project. The token can do anything that account can do, so consider a dedicated account.

Pick an expiry and copy the token; GitLab shows it only once. Then, in Inklayer, choose **GitLab** and fill in:

| Field | Example | Where to find it |
|---|---|---|
| Project path | `acme/website` | Everything after the host in the project's address, including any subgroups: `gitlab.com/acme/web/website` → `acme/web/website` |
| Instance address | leave empty | Only for **self-managed** GitLab: `https://gitlab.acme.com` |
| Access token | `glpat-…` | From above |

The project must have Issues turned on (**Settings → General → Visibility, project features, permissions → Issues**). Inklayer checks this when you save.

### Codeberg, Forgejo and Gitea

Codeberg runs Forgejo, and Forgejo and Gitea share an API, so one tracker covers all three: Codeberg, and any self-hosted Forgejo or Gitea.

1. On the instance, open **Settings → Applications → Generate new token** (on Codeberg: [codeberg.org/user/settings/applications](https://codeberg.org/user/settings/applications)).
2. Name it, and under **Select permissions**, set **issue: Read and write** and **repository: Read**. Leave the rest at **No access**.
3. **Generate token** and copy it. It's shown only once.
4. In Inklayer, choose **Codeberg, Forgejo, Gitea** and fill in:

   | Field | Example | Where to find it |
   |---|---|---|
   | Owner | `acme` | The first part of the repository address, `codeberg.org/acme/website` |
   | Repository | `website` | The second part |
   | Instance address | leave empty for Codeberg | For your own Forgejo or Gitea: `https://git.acme.com` |
   | Access token | | From step 3 |

Issues are created as the token's account, which needs write access to the repository's issues: a collaborator, or a team member with access to issues. The repository must have issues turned on (**Settings → Units**, or **Settings → Advanced settings** on older versions). Inklayer checks this when you save. Older Gitea versions (before 1.19) don't have token permissions, so any token works there.

### Jira Cloud

You need an Atlassian account that can work in the Jira project, and an **API token** for it. Consider a dedicated account (such as `inklayer@acme.com`), since issues are created in its name.

1. Sign in to Atlassian as that account and open [id.atlassian.com → Security → API tokens](https://id.atlassian.com/manage-profile/security/api-tokens).
2. Choose **Create API token** (not "Create API token with scopes": scoped tokens don't work with the site address Inklayer uses). Name it, choose an expiry, and copy the token.
3. Make sure the account has these permissions in the Jira project: **Browse projects**, **Create issues**, **Transition issues** and **Add comments**. Inklayer needs Transition issues to move issues to Done when comments are resolved, and Add comments to post on linked issues.
4. In Inklayer, choose **Jira** and fill in:

   | Field | Example | Where to find it |
   |---|---|---|
   | Site | `https://acme.atlassian.net` | The start of any Jira address in your browser |
   | Project key | `WEB` | The letters before the number in issue keys (`WEB-123`), or **Project settings → Details** |
   | Account email | `inklayer@acme.com` | The account from step 1 |
   | Issue type | `Bug` | Chosen from the project's issue types once the site, project key and token (or your own account) are filled in. Bug is picked if the project has it |
   | API token | | From step 2 |

When a comment is resolved, Inklayer moves its issue through the first available transition into a **Done**-category status. If the workflow has no such transition from the issue's current status, the connection shows an error and the issue stays as it is. Closing an issue in Jira means any **Done**-category status.

Only Jira Cloud is supported. Jira Server and Data Center use a different API.

### Linear

You need a **personal API key** and the **team id**. Issues are created as the person who owns the key.

1. In Linear, open **Settings → Account → Security & access → Personal API keys** and create a key.
2. If Linear asks for permissions, allow **Read** and **Write**. Inklayer creates issues, reads their state, and moves them to a completed state. If it asks for team access, include the team.
3. Copy the key. Linear shows it only once.
4. Find the team id: open the team in Linear, press **Cmd/Ctrl+K**, and run **Copy model UUID**. It looks like `a1b2c3d4-…`.
5. In Inklayer, choose **Linear** and fill in the **Team id** and **API key**.

When a comment is resolved, Inklayer moves its issue to the team's first **Completed**-type state. An issue that is completed or canceled in Linear resolves its comment.

### Azure DevOps

Inklayer creates **work items** in Azure Boards. It works with Azure DevOps Services and Azure DevOps Server. You need a **personal access token**, and work items are created as the person who owns it. Consider a dedicated account, since Azure DevOps tokens expire after at most a year.

1. In Azure DevOps, open **User settings** (the icon next to your picture, top right) **→ Personal access tokens → New Token**.
2. **Organization:** the organisation that has the project. **Expiration:** pick one and note the date.
3. **Scopes:** **Custom defined**, then **Work Items: Read & write**. Nothing else is needed.
4. **Create** and copy the token. Azure DevOps shows it only once.
5. Make sure the token's account is a member of the project and can create and edit work items in it. A Stakeholder licence is enough for that.
6. In Inklayer, choose **Azure DevOps** and fill in:

   | Field | Example | Where to find it |
   |---|---|---|
   | Organisation address | `https://dev.azure.com/acme` | The start of any Azure DevOps address, up to the organisation. Older organisations use `https://acme.visualstudio.com`. For Azure DevOps Server, the collection's address, such as `https://tfs.acme.com/DefaultCollection` |
   | Project | `Web Shop` | The project's name, as it appears after the organisation in the address |
   | Work item type | `Bug` | Chosen from the project's work item types once the organisation, project and token (or your own account) are filled in. Bug is picked if the process has it, else Issue (the **Basic** process) or Task |
   | Personal access token | | From step 4 |

Inklayer checks the token by looking up the work item type in the project, so a wrong project or type shows up when you save. The comment's text, page details and link go into **Repro Steps** for bugs, and into **Description** for other types. To change the type later, pick another next to **Work item type** in the tracker's row.

Open or closed follows the state's **category**, so custom states work too. When a comment is resolved, Inklayer moves its work item to the type's first **Completed**-category state (Done or Closed in the standard processes). A work item moved to a **Completed** or **Removed** state resolves its comment, and one moved back reopens it. **Resolved** states, such as a bug waiting to be verified, still count as open. If the process has rules that block the change, such as a required field, the connection shows the error and the work item stays as it is.

## Notifications

Everyone gets in-app notifications under the bell, and a count on the extension's icon. Organisation Admins can also send notifications elsewhere from the organisation's **Integrations** tab. Each integration has a **Test** button, and shows its last error and when it last sent.

Messages wait in an outbox and are retried with growing gaps, up to 8 tries. Addresses and secrets are stored encrypted.

Slack and webhook integrations choose which **events** they send: new comments, mentions, replies, resolved comments, and issues created. They can also be limited to **one project**.

### Email

Email sends each person their own notifications: mentions, replies in their threads, and their comments being resolved. Everyone can turn emails off for themselves in **Settings**.

1. **Instance administrator:** give the server SMTP settings and restart it.

   ```bash
   INKLAYER_SMTP_HOST=email-smtp.ap-southeast-2.amazonaws.com
   INKLAYER_SMTP_PORT=587          # 587 uses STARTTLS; 465 uses TLS from the start
   INKLAYER_SMTP_USERNAME=…
   INKLAYER_SMTP_PASSWORD=…
   INKLAYER_SMTP_FROM=Inklayer <inklayer@acme.com>
   ```

   With **Amazon SES**, create SMTP credentials in the SES console (**SMTP settings → Create SMTP credentials**). They are not your AWS access keys. Also verify the sender address or its domain. An SES account still in the sandbox can only send to verified addresses.

2. **Instance administrator:** on the **Admin** page, the **Email** section should say **Set up**. Use **Send me a test email** to check it.
3. **Organisation Admin:** in the organisation's **Integrations** tab, add **Email**.

### Slack

Slack posts notifications to a channel through an **incoming webhook**.

1. Open [api.slack.com/apps](https://api.slack.com/apps), choose **Create New App → From scratch**, and pick a name (such as "Inklayer") and the workspace.
2. In the app, open **Incoming Webhooks** and turn it on.
3. Choose **Add New Webhook to Workspace**, pick the channel, and allow it.
4. Copy the webhook address (`https://hooks.slack.com/services/…`).
5. In Inklayer's **Integrations** tab, add **Slack**. Give it a name (such as `#design-review`), paste the address, choose the events and, if you like, one project. Then press **Test**.

For another channel, add another webhook to the same Slack app and another Slack integration in Inklayer.

### Webhooks

A webhook posts JSON to any `https://` address, for your own tools or for automation services.

1. In the **Integrations** tab, add **Webhook** with the address, the events and, if you like, one project.
2. Copy the **signing secret**. It is shown only once.
3. On the receiving side, check each request's signature before trusting it. `X-Inklayer-Signature` is `sha256=` followed by the lower-case hex HMAC-SHA256 of the raw request body, keyed with the secret. `X-Inklayer-Event` names the event.

A notification looks like this:

```json
{
  "event": "comment.created",
  "at": "2026-11-20T08:00:00+00:00",
  "organizationId": "…",
  "projectId": "…",
  "actor": { "id": "…", "name": "Rosie" },
  "comment": {
    "id": "…",
    "url": "https://inklayer.acme.com/…",
    "pageUrl": "https://shop.acme.com/checkout",
    "status": "Open",
    "text": "The pay button is hidden behind the cookie banner"
  }
}
```

Events are `comment.created`, `mention`, `reply`, `comment.resolved` and `issue.created`. **Test** sends `{"event":"test","at":"…"}`.

For example, in Node.js:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function isFromInklayer(rawBody, header, secret) {
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  return header?.length === expected.length && timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}
```

**Discord:** use a **Slack** integration rather than a webhook. Discord accepts Slack-style messages when `/slack` is added to the end of its webhook address. In Discord, open **Server settings → Integrations → Webhooks → New Webhook**, pick the channel, copy the address, and add it in Inklayer as `https://discord.com/api/webhooks/…/slack`.

**Microsoft Teams:** Teams channels don't accept arbitrary JSON. In Power Automate, create a flow that starts with **When an HTTP request is received** and then posts a message to the channel using fields from the JSON above. Add the flow's address in Inklayer as a **Webhook**.

## AI assistants (MCP)

Assistants such as Claude can use Inklayer as you, through its MCP server at `https://<your Inklayer domain>/api/mcp`. They can read and reply to comments, resolve them, create issues, and read and edit docs, wherever your role allows.

The **Connected apps** section on Inklayer's home page has everything below filled in for your server, with copy buttons. It also lists the apps you've allowed, so you can disconnect any of them. The extension's popup links there until you've connected one.

| Assistant | How |
|---|---|
| **VS Code, Cursor** | **Add to VS Code** or **Add to Cursor** under Connected apps. The editor opens your browser to sign in. |
| **Claude Code** | `claude mcp add --transport http inklayer https://<your Inklayer domain>/api/mcp`, then `/mcp` in Claude Code to sign in. |
| **Claude Code, signing in on start** | Needs Node.js: `claude mcp add inklayer -- npx -y mcp-remote https://<your Inklayer domain>/api/mcp --static-oauth-client-metadata '{"token_endpoint_auth_method":"none"}'`. It opens your browser to sign in the first time Claude Code starts. The flag is needed because Inklayer only registers public (PKCE) clients. |
| **Claude Desktop, claude.ai** | **Settings → Connectors → Add custom connector** with the address. |

Signing in shows Inklayer's consent page, naming the app and where it will send you back to. Only allow apps you started connecting yourself. claude.ai and Claude Desktop connect from Anthropic's cloud, so they can't reach a server limited to your VPN. Claude Code and the editors run on your machine and connect through it.
