# Sign-in: Google, single sign-on, or your own identity server

Inklayer stores no passwords. It signs people in through Google, or through any identity provider that supports **OpenID Connect** (OIDC), instead of Google or alongside it. With more than one provider configured, the sign-in page shows a button for each.

Until one is set up, nobody can sign in. The server says so in its log when it starts, and the sign-in page lists the options.

**Which one?**

- **Your company already has an identity provider:** use it. Steps for [JumpCloud](#jumpcloud), [Okta](#okta), [Microsoft Entra ID](#microsoft-entra-id), [Keycloak](#keycloak), [Authentik](#authentik) and [Auth0](#auth0) are below, and [any other OIDC provider](#any-other-oidc-provider) works the same way.
- **Everyone has a Google account** (Google Workspace, or personal Gmail): use [Google](#google). There's no extra server to run.
- **Just you, or a few people, with neither:** run the small [Dex](#running-inklayer-by-yourself) identity server that comes with Inklayer.

**Setting it up with an AI coding assistant** (Claude Code, Cursor, Copilot and the like): open the folder you run Inklayer from and give it this doc, for example:

> Set up sign-in for my Inklayer server by following docs/sso-oidc.md, starting with "Instructions for AI assistants".

It asks you a few questions and does the file and Docker work. You still click through your provider's admin console yourself, with the assistant telling you what to set. Running Dex needs no console, so the assistant can do all of it.

**Adding a second provider:** once you can sign in as an administrator, add more providers under **Admin → Sign-in providers** instead of editing the configuration. See [Adding providers from the Admin page](#adding-providers-from-the-admin-page).

SAML-only providers aren't supported directly. Put a broker that speaks OIDC in front of them, such as Keycloak, Authentik or Dex.

## Adding providers from the Admin page

The first provider has to be in the server's configuration (below), because someone has to sign in before they can use the Admin page. After that, an instance administrator can add more under **Admin → Sign-in providers**, with no `.env` change and no restart:

1. Choose **Add a provider**, and pick the provider from the list (Okta, Microsoft Entra ID, JumpCloud, Keycloak, Authentik, Auth0, Dex or another). This fills in a suggested id and button text, and links to that provider's steps below.
2. Copy the **redirect URI** shown, and register it at the provider as that provider's steps say.
3. Enter the issuer address, client ID, client secret and, for a company provider, your verified email domains.
4. Choose **Add provider**. The server first reads the provider's discovery document, and tells you if the address is wrong or it can't reach it. Once saved, the sign-in page shows the new button straight away.

Providers added there can be edited or removed there. The client secret is stored encrypted in the database and never shown again: leave the box empty when editing to keep it. Providers from the server's configuration are listed too, but they're changed in the configuration.

Inklayer won't remove the last provider, or one that's the only way you sign in, so you can't lock everyone out by accident. People who signed in only with a removed provider need another way in. The table shows how many people use each one. Adding, changing and removing providers is recorded in the audit log, without the secret.

The secret is encrypted with the server's keys in `/data/keys`, which aren't in the database backup. If you restore the database onto a new server without them, the provider stays listed but leaves the sign-in page, marked **Enter its secret again**: edit it and enter the client secret. Make sure you can still sign in another way, such as a provider in the configuration, or keep a copy of `/data/keys` (see [Keys](deploy-aws-lightsail.md#keys)).

If the configuration later sets up a provider with the same id as one added on the Admin page, the configuration's wins, and the server logs a warning.

## Settings

These are the settings for providers in the server's configuration.


| Setting (`Inklayer:Auth:Oidc:0:…`) | Docker `.env` | What it is |
|---|---|---|
| `Id` | `OIDC_ID` | Short id, e.g. `jumpcloud`: lower-case letters, digits and dashes. It is part of the redirect URI and links people to their provider accounts, so **don't change it** once people have signed in. |
| `DisplayName` | `OIDC_DISPLAY_NAME` | Button text: "Sign in with *JumpCloud*". |
| `Authority` | `OIDC_AUTHORITY` | The provider's issuer URL. The server must be able to reach `<Authority>/.well-known/openid-configuration`. |
| `ClientId`, `ClientSecret` | `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | From the app you register at the provider. |
| `Scopes` | `OIDC_SCOPES` | Default `openid email profile`. |
| `VerifiedDomains` | `OIDC_VERIFIED_DOMAINS` | Email domains this provider is the authority for, comma-separated. See [below](#verified-domains). |

Register this **redirect URI** at the provider: `https://<your Inklayer domain>/auth/callback/<Id>`, for example `https://inklayer.example.com/auth/callback/jumpcloud`.

For a second OIDC provider, use index `1` (`Inklayer:Auth:Oidc:1:Id`, …) in `appsettings.json`, user secrets or environment variables (`Inklayer__Auth__Oidc__1__Id`).

The server refuses to start if a provider is only partly configured, has an invalid id, or has an authority that isn't `https`.

## Google

Google uses its own settings, not the `OIDC_*` ones, and its id is always `google`.

1. In the [Google Cloud console](https://console.cloud.google.com/), pick or create a project, then open **Google Auth Platform** (formerly **APIs & Services → OAuth consent screen**). Set the app name and support email. For **Audience**, choose **Internal** if only your Google Workspace should sign in, or **External** for any Google account.
2. Under **Clients** (or **APIs & Services → Credentials**), choose **Create client → OAuth client ID**, type **Web application**.
3. Add the **Authorized redirect URI** `https://inklayer.example.com/auth/callback/google`, then create it and copy the **Client ID** and **Client secret**.
4. Configure Inklayer:

   ```bash
   GOOGLE_CLIENT_ID=<client id>
   GOOGLE_CLIENT_SECRET=<client secret>
   INKLAYER_BOOTSTRAP_ADMINS=you@example.com
   ```

   Then run `docker compose up -d`.

Google sends `email_verified`, and Google Workspace users join organisations that allow their domain, so Google needs no `VerifiedDomains`.

## Running Inklayer by yourself

If you're on your own, or a few people, and don't want to use Google, run [Dex](https://dexidp.io/) next to Inklayer. Dex is a small open-source identity server. It keeps the accounts you list in one file, so there's no database or admin console to look after.

It needs its own address, such as `id.example.com`, behind the same Caddy as Inklayer. The Inklayer server must be able to reach that address too.

1. **Create the Dex config** in the `deploy` folder:

   ```bash
   cp dex/config.yaml.example dex/config.yaml
   openssl rand -hex 32                                                        # the client secret
   docker run --rm httpd:2-alpine htpasswd -nbBC 10 "" 'your password' | tr -d ':\n'   # a password hash
   ```

   In `dex/config.yaml`, set:
   - `issuer` to Dex's address, `https://id.example.com`;
   - the client's `secret` to the random value, and its first redirect URI to `https://<your Inklayer domain>/auth/callback/dex`;
   - under `staticPasswords`, your email and the password hash. Add an entry for each person, each with a different `userID`.

   `dex/config.yaml` holds the secret and the password hashes, so it's git-ignored.

2. **Give Dex an address.** Point `id.example.com` at the server in DNS, and add it to your Caddyfile (there's a commented example in `Caddyfile.example`):

   ```
   id.example.com {
   	reverse_proxy dex:5556
   }
   ```

3. **Configure Inklayer** in `.env`:

   ```bash
   OIDC_ID=dex
   OIDC_DISPLAY_NAME=Dex
   OIDC_AUTHORITY=https://id.example.com
   OIDC_CLIENT_ID=inklayer
   OIDC_CLIENT_SECRET=<the same secret as in dex/config.yaml>
   INKLAYER_BOOTSTRAP_ADMINS=you@example.com
   ```

4. **Start both:**

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.dex.yml up -d
   ```

   Sign in with your email and password. You're the administrator, because your email is in `INKLAYER_BOOTSTRAP_ADMINS`.

To add someone, add them under `staticPasswords`, run `docker compose -f docker-compose.yml -f docker-compose.dex.yml restart dex`, and invite their email in Inklayer. To change a password, replace the hash and restart Dex the same way. Dex marks these emails as verified, so `VerifiedDomains` isn't needed.

**Trying it on your own computer, without HTTPS:** the browser and the Inklayer container must both reach Dex at the same address, and `localhost` means something different inside the container. Use `dex` as the name:

- in `dex/config.yaml`, set `issuer: http://dex:5556` (the `http://localhost:8080/auth/callback/dex` redirect URI is already there);
- in `.env`, set `OIDC_AUTHORITY=http://dex:5556` and `INKLAYER_ALLOW_INSECURE_HTTP=true`;
- add `127.0.0.1 dex` to your hosts file (`/etc/hosts`, or `C:\Windows\System32\drivers\etc\hosts`), so your browser finds Dex too.

Then start both and open `http://localhost:8080`.

When people should change their own passwords, or you want passkeys or two-factor sign-in, use a fuller identity server instead, such as [Authentik](#authentik), [Keycloak](#keycloak) or Pocket ID.

## JumpCloud

1. In the JumpCloud Admin Portal, go to **SSO Applications → Add New Application → Custom Application**, and choose to manage single sign-on with **OIDC**.
2. On the SSO tab, set:
   - **Redirect URIs:** `https://inklayer.example.com/auth/callback/jumpcloud`
   - **Client Authentication Type:** Client Secret Basic
   - **Login URL:** `https://inklayer.example.com/auth/login?provider=jumpcloud`
   - **Standard scopes:** include **Email** and **Profile**, so Inklayer receives the email address and name.
3. Save the application, then copy the **Client ID** and **Client Secret**. JumpCloud shows the secret only once.
4. Under **User Groups**, bind the groups that should be able to use Inklayer.
5. Configure Inklayer:

   ```bash
   OIDC_ID=jumpcloud
   OIDC_DISPLAY_NAME=JumpCloud
   OIDC_AUTHORITY=https://oauth.id.jumpcloud.com/
   OIDC_CLIENT_ID=<client id>
   OIDC_CLIENT_SECRET=<client secret>
   OIDC_VERIFIED_DOMAINS=acme.com
   ```

   Then run `docker compose up -d`.

JumpCloud's console changes from time to time. If a label above doesn't match, the settings to look for are the redirect URI, client-secret authentication, and the email and profile scopes.

## Okta

1. In the Okta Admin Console, go to **Applications → Applications → Create App Integration**. Choose **OIDC – OpenID Connect**, then **Web Application**.
2. Set:
   - **Grant type:** Authorization Code;
   - **Sign-in redirect URIs:** `https://inklayer.example.com/auth/callback/okta`;
   - **Assignments:** the people or groups who should use Inklayer.
3. Save, then copy the **Client ID** and **Client secret** from the **General** tab.
4. Configure Inklayer:

   ```bash
   OIDC_ID=okta
   OIDC_DISPLAY_NAME=Okta
   OIDC_AUTHORITY=https://<your-org>.okta.com
   OIDC_CLIENT_ID=<client id>
   OIDC_CLIENT_SECRET=<client secret>
   OIDC_VERIFIED_DOMAINS=acme.com
   ```

The authority is your Okta domain (which can be `….oktapreview.com` or your own custom domain). If you use a custom authorization server, the authority is its issuer instead, such as `https://<your-org>.okta.com/oauth2/default`.

## Microsoft Entra ID

1. In the [Microsoft Entra admin center](https://entra.microsoft.com/), go to **Identity → Applications → App registrations → New registration**.
2. Set:
   - **Supported account types:** accounts in this organisational directory only;
   - **Redirect URI:** platform **Web**, `https://inklayer.example.com/auth/callback/entra`.
3. Register it. On the **Overview** page, copy the **Application (client) ID** and the **Directory (tenant) ID**.
4. Under **Certificates & secrets → New client secret**, create a secret and copy its **Value** (not the Secret ID). It's shown once, and it expires: note the date and replace it before then.
5. Under **Token configuration → Add optional claim**, choose **ID** and add **email**.
6. To limit who can sign in, open the app under **Enterprise applications**, set **Properties → Assignment required** to **Yes**, and add people or groups under **Users and groups**. Otherwise everyone in the tenant can sign in, subject to Inklayer's own rules.
7. Configure Inklayer:

   ```bash
   OIDC_ID=entra
   OIDC_DISPLAY_NAME=Microsoft
   OIDC_AUTHORITY=https://login.microsoftonline.com/<tenant id>/v2.0
   OIDC_CLIENT_ID=<application (client) id>
   OIDC_CLIENT_SECRET=<secret value>
   OIDC_VERIFIED_DOMAINS=acme.com
   ```

Entra ID doesn't send `email_verified`, so list your domains in `OIDC_VERIFIED_DOMAINS`. The `email` claim is the user's mailbox address: accounts without a mailbox, such as some guests and service accounts, have none and can't sign in.

## Keycloak

1. In the Keycloak admin console, pick your realm, then **Clients → Create client**. Choose **OpenID Connect**, and set the client ID to `inklayer`.
2. Turn **Client authentication** on, and keep **Standard flow** on.
3. Set **Valid redirect URIs** to `https://inklayer.example.com/auth/callback/keycloak`, and save.
4. Copy the **Client secret** from the **Credentials** tab.
5. Configure Inklayer:

   ```bash
   OIDC_ID=keycloak
   OIDC_DISPLAY_NAME=Keycloak
   OIDC_AUTHORITY=https://keycloak.example.com/realms/<realm>
   OIDC_CLIENT_ID=inklayer
   OIDC_CLIENT_SECRET=<client secret>
   ```

Keycloak sends `email_verified` from each user's **Email verified** setting. Turn that on for your users (or turn on **Verify email** for the realm), or list your domains in `OIDC_VERIFIED_DOMAINS`. Keycloak before version 17 has `/auth` in the authority: `https://keycloak.example.com/auth/realms/<realm>`.

## Authentik

1. In the Authentik admin interface, go to **Applications → Applications → Create with provider** (or create the provider first under **Applications → Providers**). Choose **OAuth2/OpenID Provider**.
2. Set:
   - **Client type:** Confidential;
   - **Redirect URIs:** `https://inklayer.example.com/auth/callback/authentik` (Strict);
   - **Signing key:** any certificate, such as the built-in self-signed one. Without one, tokens are signed with the client secret, which Inklayer doesn't accept.
3. Give the application the slug `inklayer`, and copy the **Client ID** and **Client Secret** from the provider.
4. To limit who can sign in, bind groups or users to the application.
5. Configure Inklayer:

   ```bash
   OIDC_ID=authentik
   OIDC_DISPLAY_NAME=Authentik
   OIDC_AUTHORITY=https://authentik.example.com/application/o/inklayer/
   OIDC_CLIENT_ID=<client id>
   OIDC_CLIENT_SECRET=<client secret>
   OIDC_VERIFIED_DOMAINS=acme.com
   ```

Depending on the version and its scope mappings, Authentik may send `email_verified` as false. List your domains in `OIDC_VERIFIED_DOMAINS` so this doesn't matter.

## Auth0

1. In the Auth0 dashboard, go to **Applications → Applications → Create Application**, and choose **Regular Web Applications**.
2. On the **Settings** tab, set **Allowed Callback URLs** to `https://inklayer.example.com/auth/callback/auth0`, and save.
3. Copy the **Domain**, **Client ID** and **Client Secret**.
4. Configure Inklayer:

   ```bash
   OIDC_ID=auth0
   OIDC_DISPLAY_NAME=Auth0
   OIDC_AUTHORITY=https://<domain>/
   OIDC_CLIENT_ID=<client id>
   OIDC_CLIENT_SECRET=<client secret>
   ```

Auth0 sends `email_verified`. If your users sign up with their own email and password, they're verified only after clicking Auth0's verification email.

## Any other OIDC provider

Any provider that supports OpenID Connect's authorization code flow works. At the provider:

1. Register a "web" (confidential) application.
2. Set its redirect URI (also called callback or reply URL) to `https://<your Inklayer domain>/auth/callback/<Id>`.
3. Allow the scopes `openid email profile`.
4. Copy the client ID and secret, and find the **issuer** URL: the address that ends before `/.well-known/openid-configuration`.

Then set the `OIDC_*` settings [above](#settings). If people see "didn't confirm that your email address is verified", the provider doesn't send `email_verified`: add your domains to `OIDC_VERIFIED_DOMAINS`.

## Verified domains

Most company identity providers don't send the `email_verified` claim that Google sends. `VerifiedDomains` tells Inklayer which addresses this provider can vouch for. For someone whose email is in one of those domains:

- **The email counts as verified**, even without `email_verified`.
- **They join organisations by domain.** If an organisation allows `acme.com` (Organisation settings → email domains), they join it automatically with its default role, just as Google Workspace users do.
- **Their existing account is linked.** If they already have an Inklayer account with that email (for example, from signing in with Google), the provider is added to that account, so their comments and roles carry over. They can use either sign-in afterwards.

Emails outside these domains still need the provider's `email_verified` claim. Those people don't join organisations by domain, and are refused if their email already belongs to a different account.

Only list domains whose accounts this provider controls. Anyone who can create a provider account with an `@acme.com` email would be trusted as that person.

## Who can sign in

The rules are the same for every provider. A person gets in if they:

- already have an account that isn't disabled;
- are listed in `INKLAYER_BOOTSTRAP_ADMINS`;
- have a pending invitation for their verified email; or
- come from a verified domain that an organisation allows.

Everyone else sees "not invited".

## Troubleshooting

- **"Sign-in didn't complete":** the server logs a warning with the reason. The usual causes are a redirect URI mismatch, a wrong client secret, or a server that can't reach the provider's `/.well-known/openid-configuration`.
- **"Your sign-in provider didn't confirm that your email address is verified":** add the person's domain to `VerifiedDomains`, or have the provider send `email_verified`.
- **Dex stops with "malformed bcrypt hash":** a password in `dex/config.yaml` is still the example's placeholder, or was pasted without its `$2y$10$` start. Make a hash as in [step 1](#running-inklayer-by-yourself) and put it in double quotes.
- **"…already belongs to an Inklayer account that signs in a different way":** the person signed in another way before, and this provider isn't verified for their email's domain. Add the domain to `VerifiedDomains`, or have them use their original sign-in.

## Instructions for AI assistants

You're helping someone set up sign-in for their own Inklayer server. Follow these steps in order. The rest of this doc has the details for each provider: read the section for the one they choose before you start on it.

### Ground rules

- **Secrets stay on their machine.** Client secrets, password hashes and `.env` never go into a commit, an issue, a web search or any other outside service. Don't repeat a secret back in chat once it's written to a file. `.env` and `deploy/dex/config.yaml` are git-ignored: keep them that way.
- **Keep what's already there.** Edit `.env` key by key: set or uncomment the lines you need, and don't add a second copy of a key or remove unrelated settings. Look at a file before you overwrite it.
- **You can't use provider admin consoles.** For Google, JumpCloud, Okta, Entra ID, Keycloak, Authentik and Auth0, give the person the console steps from that provider's section a few at a time, filling in their real redirect URI. Then ask them for the client ID and authority. For the client secret, ask them to put it in `.env` themselves, or to paste it so you can write it there.
- **Ask before anything that changes their running server** (restarting containers, editing a Caddyfile in use). Say what will happen first.

### 1. Find the setup

- Find the compose file they run: usually `deploy/docker-compose.yml`, or `deploy/lightsail/docker-compose.yml` for the [Lightsail deployment](deploy-aws-lightsail.md). Run every `docker compose` command from that folder. Its `.env` sits next to it: if there's none yet, copy `.env.example`.
- Read the `.env` for what's already set: `GOOGLE_*`, `OIDC_*`, `INKLAYER_BOOTSTRAP_ADMINS`, and the public address (`INKLAYER_PUBLIC_URL`, or `INKLAYER_DOMAIN` on Lightsail).
- If the server is running, `docker compose logs server | grep -i "sign-in provider"` shows whether it has any provider yet.

### 2. Ask what you can't find out

Ask only what's still missing:

1. **Is sign-in already working?** If a provider is already set up and they can sign in as an administrator, a second provider is quicker to add under **Admin → Sign-in providers** ([details](#adding-providers-from-the-admin-page)). Walk them through that page and the provider's console instead of editing `.env`, unless they want it in the configuration.
2. **Which sign-in:** their company's identity provider (which one?), Google, or Dex for running it by themselves. If they're unsure, use the "Which one?" list at the top of this doc to recommend one.
3. **Inklayer's public address**, such as `https://inklayer.example.com`, or `http://localhost:8080` for a trial on their own computer.
4. **The administrator's email**, for `INKLAYER_BOOTSTRAP_ADMINS`.
5. For a company provider: **their email domains**, for `OIDC_VERIFIED_DOMAINS`. Leave this out for Google, Dex and Auth0 (see [Verified domains](#verified-domains)).
6. For Dex: **who signs in** (each person's email), and **Dex's own address**, such as `https://id.example.com`, whose DNS points at the same server.

### 3. Configure

**A company provider or Google:**

1. Choose the id: the provider's name in lower case, as in its section (`okta`, `entra`, `keycloak`, …). Google's is always `google`. Work out the redirect URI, `<public address>/auth/callback/<id>`, and give it to the person with the console steps.
2. Once they have the client ID, secret and authority, set the lines that provider's section shows in `.env`, plus `INKLAYER_BOOTSTRAP_ADMINS`.
3. Check the authority before restarting. `curl -sf <authority>/.well-known/openid-configuration` should return JSON whose `issuer` matches the authority (a trailing `/` aside). If it doesn't, the authority is wrong: fix it now, not after a failed sign-in.

**Dex:** follow [Running Inklayer by yourself](#running-inklayer-by-yourself), doing the steps yourself:

1. `cp dex/config.yaml.example dex/config.yaml` in the `deploy` folder. Set `issuer` to Dex's address, set the client `secret` to the output of `openssl rand -hex 32`, and set the first redirect URI to `<public address>/auth/callback/dex`.
2. For each person, add a `staticPasswords` entry with their email, a `username`, a `userID` from `uuidgen`, and a bcrypt hash in double quotes. Ask each person to choose a password and make the hash with `docker run --rm httpd:2-alpine htpasswd -nbBC 10 "" '<password>' | tr -d ':\n'`. Or generate a strong one (`openssl rand -base64 18`), give it to them once, and tell them it can't be shown again.
3. Set the Dex lines in `.env` (`OIDC_ID=dex`, `OIDC_AUTHORITY` the same as `issuer`, `OIDC_CLIENT_ID=inklayer`, `OIDC_CLIENT_SECRET` the same secret), plus `INKLAYER_BOOTSTRAP_ADMINS`.
4. Give Dex its address in Caddy: add the `id.example.com` block from the Dex section to the Caddyfile in use, with their real hostname. Check the DNS first with `dig +short <dex hostname>`.
5. For a trial on their own computer, follow the HTTP steps at the end of the Dex section instead of steps 4 and DNS. Adding `127.0.0.1 dex` to the hosts file needs administrator rights: ask them to do it, or ask before using `sudo`.
6. On Lightsail, the compose file is in `deploy/lightsail`, so put Dex's config at `deploy/lightsail/dex/config.yaml` and add `-f ../docker-compose.dex.yml` to the commands. The Caddyfile there is `deploy/lightsail/Caddyfile`.

### 4. Start and check

1. Start the server again with the new settings: `docker compose up -d`. With Dex, use `docker compose -f docker-compose.yml -f docker-compose.dex.yml up -d` for this and every later command. `up -d` recreates the containers whose settings changed, and a plain `restart` doesn't read `.env` again.
2. Check `docker compose logs --tail 50 server`:
   - the warning "No sign-in provider is configured" should be gone;
   - an "OIDC provider … " error means the settings are wrong or incomplete, and the server won't start until they're fixed. The message says which setting.
3. Check that the provider is offered: `curl -s <public address>/auth/providers` should list its id and name.
4. Check that the server can reach the provider from inside Docker. The server image has no shell or curl, so use a throwaway container on its network: `docker run --rm --network inklayer_default curlimages/curl -sf <authority>/.well-known/openid-configuration`.
5. Ask the person to open `<public address>`, sign in, and tell you what happens. If it fails, read the server log and go through [Troubleshooting](#troubleshooting).

### 5. Finish

Tell the person:

- the sign-in that's set up, and that their email becomes administrator when they first sign in;
- how others get in: an invitation, or for a company provider, an organisation that allows their email domain (see [Who can sign in](#who-can-sign-in));
- for Dex, how to add a person or change a password (edit `dex/config.yaml`, then restart Dex);
- for Entra ID, when the client secret expires.

Don't commit anything unless they ask. Their `.env` and Dex config must never be committed.
