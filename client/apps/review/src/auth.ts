import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Signing in to Inklayer as the person, with OAuth 2.0 authorization code + PKCE: the helper opens the server's sign-in
 * page in their browser and waits on a loopback address for the code. The server knows this client
 * (FirstPartyClientSeeder.ReviewClientId) and asks the person to allow it once. Tokens are kept in
 * ~/.config/inklayer/review.json (only the person can read it), one entry per server, and refreshed as needed.
 * Unit-tested: test/auth.test.ts.
 */

export const CLIENT_ID = "inklayer-review";
/** The redirect addresses the server allows for this client, tried in order until one's port is free. */
export const PORTS = [47821, 47822, 47823];
const SCOPE = "openid profile offline_access";
/** How long to wait for the person to sign in and allow the helper. */
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
/** Refresh a little before the access token runs out. */
const EARLY_MS = 60 * 1000;

export interface Tokens {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface AuthOptions {
  serverUrl: string;
  /** Where tokens are kept (default ~/.config/inklayer/review.json). */
  file?: string;
  fetch?: typeof fetch;
  /** Opens the sign-in page; by default in the person's browser. */
  openUrl?: (url: string) => void;
  log?: (line: string) => void;
}

type Stored = Record<string, Tokens>;

export class Auth {
  readonly serverUrl: string;
  readonly #file: string;
  readonly #fetch: typeof fetch;
  readonly #openUrl: (url: string) => void;
  readonly #log: (line: string) => void;
  #signingIn: Promise<Tokens> | null = null;

  constructor(o: AuthOptions) {
    this.serverUrl = new URL(o.serverUrl).origin;
    this.#file = o.file ?? join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "inklayer", "review.json");
    this.#fetch = o.fetch ?? fetch;
    this.#openUrl = o.openUrl ?? openInBrowser;
    this.#log = o.log ?? ((line) => process.stderr.write(`${line}\n`));
  }

  /** A valid access token: the saved one, refreshed, or (if neither works) from signing in again in the browser. */
  async accessToken(): Promise<string> {
    const saved = await this.#load();
    if (saved && saved.expiresAt - EARLY_MS > Date.now()) return saved.accessToken;
    if (saved?.refreshToken) {
      const refreshed = await this.#refresh(saved.refreshToken).catch(() => null);
      if (refreshed) return refreshed.accessToken;
    }
    return (await this.signIn()).accessToken;
  }

  /** After a 401: the token was revoked or expired early. Tries the refresh token, then signing in. */
  async renew(): Promise<string> {
    const saved = await this.#load();
    const refreshed = saved?.refreshToken ? await this.#refresh(saved.refreshToken).catch(() => null) : null;
    return (refreshed ?? (await this.signIn())).accessToken;
  }

  /** Signs in through the browser. Only one sign-in at a time. */
  signIn(): Promise<Tokens> {
    this.#signingIn ??= this.#signInOnce().finally(() => {
      this.#signingIn = null;
    });
    return this.#signingIn;
  }

  async signOut(): Promise<void> {
    const all = await this.#loadAll();
    delete all[this.serverUrl];
    await this.#saveAll(all);
  }

  async #signInOnce(): Promise<Tokens> {
    const { server, port } = await listenOnFreePort();
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const verifier = base64url(randomBytes(32));
    const state = base64url(randomBytes(16));
    const url = new URL("/connect/authorize", this.serverUrl);
    url.search = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPE,
      code_challenge: base64url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
      state,
    }).toString();

    try {
      const code = waitForCode(server, state);
      this.#log(`Sign in to Inklayer in your browser to let the review helper comment as you: ${url}`);
      this.#openUrl(url.toString());
      const tokens = await this.#token({
        grant_type: "authorization_code",
        code: await code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      });
      this.#log("Signed in to Inklayer.");
      return tokens;
    } finally {
      // Free the port now, not when the browser's keep-alive connection times out.
      server.closeAllConnections();
      server.close();
    }
  }

  #refresh(refreshToken: string): Promise<Tokens> {
    return this.#token({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  async #token(form: Record<string, string>): Promise<Tokens> {
    const response = await this.#fetch(new URL("/connect/token", this.serverUrl), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...form, client_id: CLIENT_ID }),
    });
    const body = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error_description?: string;
      error?: string;
    };
    if (!response.ok || !body.access_token) {
      throw new Error(`Inklayer didn't sign the helper in: ${body.error_description ?? body.error ?? response.status}`);
    }
    const tokens: Tokens = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? null,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    };
    const all = await this.#loadAll();
    all[this.serverUrl] = tokens;
    await this.#saveAll(all);
    return tokens;
  }

  async #load(): Promise<Tokens | null> {
    return (await this.#loadAll())[this.serverUrl] ?? null;
  }

  async #loadAll(): Promise<Stored> {
    try {
      return JSON.parse(await readFile(this.#file, "utf8")) as Stored;
    } catch {
      return {};
    }
  }

  async #saveAll(all: Stored): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true, mode: 0o700 });
    await writeFile(this.#file, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
    await chmod(this.#file, 0o600);
  }
}

/** Listens on the first free port of PORTS (only on this computer). */
async function listenOnFreePort(): Promise<{ server: Server; port: number }> {
  for (const port of PORTS) {
    const server = createServer();
    const listening = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (listening) return { server, port };
  }
  throw new Error(
    `Ports ${PORTS.join(", ")} are all in use, so the helper can't receive the sign-in. Free one and try again.`,
  );
}

/** Resolves with the code once the browser comes back to the loopback address with it. */
function waitForCode(server: Server, state: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Nobody signed in within 5 minutes.")), SIGN_IN_TIMEOUT_MS);
    server.on("request", (request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        response.writeHead(404, { Connection: "close" }).end();
        return;
      }
      const page = (message: string) =>
        response
          .writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" })
          .end(`<!doctype html><title>Inklayer</title><p style="font:16px system-ui;margin:3em">${message}</p>`);
      const error = url.searchParams.get("error");
      if (url.searchParams.get("state") !== state) {
        page("This sign-in wasn't started by the review helper.");
        return;
      }
      clearTimeout(timer);
      if (error) {
        page("The review helper wasn't allowed. You can close this tab.");
        reject(new Error(`Sign-in ended: ${url.searchParams.get("error_description") ?? error}`));
        return;
      }
      page("Signed in. Claude can comment now; you can close this tab.");
      resolve(url.searchParams.get("code") ?? "");
    });
  });
}

function openInBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawn(command, [url], { stdio: "ignore", detached: true })
    .on("error", () => undefined)
    .unref();
}

export function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}
