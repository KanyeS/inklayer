# Setting up integrations

Step-by-step setup for everything Inklayer connects to:

- **[Issue trackers](#issue-trackers)**, per project: [GitHub](#github), [GitLab](#gitlab), [Codeberg, Forgejo and Gitea](#codeberg-forgejo-and-gitea), [Jira Cloud](#jira-cloud), [Linear](#linear), [Azure DevOps](#azure-devops).
- **[Notifications](#notifications)**, per organisation: [Email](#email), [Slack](#slack), [Webhooks](#webhooks) (also Discord and Microsoft Teams).
- **[AI assistants (MCP)](#ai-assistants-mcp)**, per person: Claude Code, Claude Desktop, claude.ai, VS Code, Cursor.

An administrator can turn each of these off for the whole server; see [Turning features on and off](../README.md#turning-features-on-and-off).

## Issue trackers

Project Admins connect trackers in the project's **Settings** tab, under **Issue trackers**. A project can have as many as you like, of any kind. Each connection asks for:
- a **Name**, which commenters see when they choose where an issue goes;
- whether to **close the issue when its comment is resolved** (on by default).

Inklayer checks the credentials before it saves them. Tokens are stored encrypted, and only their last four characters are shown again. **Test** on a connection checks it again later, and the connection shows the last error if syncing fails, for example when a token has expired.

Once a tracker is connected, Commenters and above choose **Create issue** on a comment, in the extension or on the comment's page. The issue includes the comment, its replies, the page address, a link back, and the page details (browser, window size, console errors, failed requests). Inklayer checks linked issues every 5 minutes. Closing an issue in the tracker resolves its comment, and reopening it reopens the comment.

### GitHub

You need a **fine-grained personal access token** that can read and write issues on the repository.

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
   | Token | `github_pat_…` | From step 6 |
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
3. Make sure the account has these permissions in the Jira project: **Browse projects**, **Create issues** and **Transition issues**. Inklayer needs the last one to move issues to Done when comments are resolved.
4. In Inklayer, choose **Jira** and fill in:

   | Field | Example | Where to find it |
   |---|---|---|
   | Site | `https://acme.atlassian.net` | The start of any Jira address in your browser |
   | Project key | `WEB` | The letters before the number in issue keys (`WEB-123`), or **Project settings → Details** |
   | Account email | `inklayer@acme.com` | The account from step 1 |
   | Issue type | `Bug` (default) | Must be an issue type the project has, spelled as Jira shows it, such as `Task` |
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
   | Work item type | `Bug` (default) | A type the project's process has. The **Basic** process has no Bug, so use `Issue` or `Task` there |
   | Personal access token | | From step 4 |

Inklayer checks the token by looking up the work item type in the project, so a wrong project or type shows up when you save. The comment's text, page details and link go into **Repro Steps** for bugs, and into **Description** for other types.

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
