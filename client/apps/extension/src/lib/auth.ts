import { getSettings, updateSettings, type Tokens } from "./settings";

export const CLIENT_ID = "inklayer-extension";
const SCOPES = "openid email profile offline_access";

export class NotSignedInError extends Error {
  constructor() {
    super("Not signed in.");
  }
}

/** The redirect URI to register on the server (Inklayer:Auth:ExtensionRedirectUris). */
export function redirectUri(): string {
  return chrome.identity.getRedirectURL();
}

/**
 * Signs in with OAuth 2.0 authorization code + PKCE against the Inklayer server. The server sends the user to their sign-on
 * provider (Google, or the organisation's SSO) if they don't have a session yet. Must run in the background worker: the popup closes when the sign-in window opens.
 */
export async function signIn(serverUrl: string): Promise<void> {
  const verifier = randomBase64Url(32);
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const state = randomBase64Url(16);

  const authorize = new URL("/connect/authorize", serverUrl);
  authorize.search = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  }).toString();

  const responseUrl = await chrome.identity.launchWebAuthFlow({ url: authorize.href, interactive: true });
  if (!responseUrl) throw new Error("Sign-in was cancelled.");
  const params = new URL(responseUrl).searchParams;
  if (params.get("error")) throw new Error(params.get("error_description") ?? params.get("error")!);
  if (params.get("state") !== state) throw new Error("Sign-in failed: the response didn't match the request.");
  const code = params.get("code");
  if (!code) throw new Error("Sign-in failed: no authorization code was returned.");

  await storeTokens(await tokenRequest(serverUrl, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    client_id: CLIENT_ID,
    code_verifier: verifier,
  }));
}

export async function signOut(): Promise<void> {
  await updateSettings({ tokens: null });
}

let refreshing: Promise<string> | null = null;

/** A valid access token, refreshed if it's about to expire. Concurrent callers share one refresh. */
export async function getAccessToken(forceRefresh = false): Promise<string> {
  const { serverUrl, tokens } = await getSettings();
  if (!serverUrl || !tokens) throw new NotSignedInError();
  if (!forceRefresh && tokens.expiresAt - Date.now() > 60_000) return tokens.accessToken;
  if (!tokens.refreshToken) {
    await signOut();
    throw new NotSignedInError();
  }

  refreshing ??= (async () => {
    try {
      const refreshed = await tokenRequest(serverUrl, { grant_type: "refresh_token", refresh_token: tokens.refreshToken!, client_id: CLIENT_ID });
      await storeTokens(refreshed);
      return refreshed.accessToken;
    } catch (error) {
      // An invalid_grant (revoked, disabled, expired) means signing in again; network errors keep the tokens for later.
      if (error instanceof TokenError) {
        await signOut();
        throw new NotSignedInError();
      }
      throw error;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

class TokenError extends Error {}

async function tokenRequest(serverUrl: string, form: Record<string, string>): Promise<Tokens> {
  const response = await fetch(new URL("/connect/token", serverUrl), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new TokenError(String(body.error_description ?? body.error ?? `Token request failed (${response.status}).`));
  return {
    accessToken: String(body.access_token),
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
    expiresAt: Date.now() + Number(body.expires_in ?? 900) * 1000,
  };
}

async function storeTokens(tokens: Tokens): Promise<void> {
  await updateSettings({ tokens });
}

function randomBase64Url(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return base64Url(buffer);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
