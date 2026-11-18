# Single sign-on with JumpCloud, Okta, Entra ID or another OIDC provider

Inklayer can sign people in through any identity provider that supports **OpenID Connect** (OIDC), instead of or alongside Google. With more than one provider configured, the sign-in page shows a button for each.

SAML-only providers aren't supported directly. Put a broker that speaks OIDC in front of them, such as Keycloak, Authentik or Dex.

## Settings

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

## Other providers

| Provider | `Authority` | Notes |
|---|---|---|
| Okta | `https://<your-org>.okta.com` (or `…/oauth2/default` for the default authorization server) | Create an "OIDC – Web Application" app integration. |
| Microsoft Entra ID | `https://login.microsoftonline.com/<tenant-id>/v2.0` | Make sure the `email` claim is sent; accounts without a mailbox may not have one. |
| Authentik, Keycloak | The provider or realm issuer URL | |

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
- **"…already belongs to an Inklayer account that signs in a different way":** the person signed in another way before, and this provider isn't verified for their email's domain. Add the domain to `VerifiedDomains`, or have them use their original sign-in.
