import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { chromium } from "playwright-core";
import { createInterface } from "node:readline";
// src/api.ts
var Api = class {
	#auth;
	#fetch;
	constructor(auth, fetchImpl = fetch) {
		this.#auth = auth;
		this.#fetch = fetchImpl;
	}
	get serverUrl() {
		return this.#auth.serverUrl;
	}
	async json(method, path, body) {
		const response = await this.#send(path, {
			method,
			headers: body === void 0 ? {} : { "Content-Type": "application/json" },
			body: body === void 0 ? void 0 : JSON.stringify(body)
		});
		return response.status === 204 ? null : await response.json();
	}
	/** Uploads a file's bytes (a screenshot or video). */
	async put(path, bytes, contentType) {
		await this.#send(path, {
			method: "PUT",
			headers: { "Content-Type": contentType },
			body: new Uint8Array(bytes)
		});
	}
	async #send(path, init) {
		const url = new URL(path, this.#auth.serverUrl);
		const attempt = (token) => this.#fetch(url, {
			...init,
			headers: {
				...init.headers,
				Authorization: `Bearer ${token}`
			}
		});
		let response = await attempt(await this.#auth.accessToken());
		if (response.status === 401) response = await attempt(await this.#auth.renew());
		if (!response.ok) throw new Error(`${init.method} ${path}: ${await problem(response)}`);
		return response;
	}
};
/** The server's problem title or message, else the status. */
async function problem(response) {
	const body = await response.json().catch(() => null);
	const detail = body?.detail ?? body?.title;
	return detail ? `${response.status} ${detail}` : `${response.status} ${response.statusText}`;
}
// src/auth.ts
/**
* Signing in to Inklayer as the person, with OAuth 2.0 authorization code + PKCE: the helper opens the server's sign-in
* page in their browser and waits on a loopback address for the code. The server knows this client
* (FirstPartyClientSeeder.ReviewClientId) and asks the person to allow it once. Tokens are kept in
* ~/.config/inklayer/review.json (only the person can read it), one entry per server, and refreshed as needed.
* Unit-tested: test/auth.test.ts.
*/
var CLIENT_ID = "inklayer-review";
/** The redirect addresses the server allows for this client, tried in order until one's port is free. */
var PORTS = [
	47821,
	47822,
	47823
];
var SCOPE = "openid profile offline_access";
/** How long to wait for the person to sign in and allow the helper. */
var SIGN_IN_TIMEOUT_MS = 3e5;
/** Refresh a little before the access token runs out. */
var EARLY_MS = 6e4;
var Auth = class {
	serverUrl;
	#file;
	#fetch;
	#openUrl;
	#log;
	#signingIn = null;
	constructor(o) {
		this.serverUrl = new URL(o.serverUrl).origin;
		this.#file = o.file ?? join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "inklayer", "review.json");
		this.#fetch = o.fetch ?? fetch;
		this.#openUrl = o.openUrl ?? openInBrowser;
		this.#log = o.log ?? ((line) => process.stderr.write(`${line}\n`));
	}
	/** A valid access token: the saved one, refreshed, or (if neither works) from signing in again in the browser. */
	async accessToken() {
		const saved = await this.#load();
		if (saved && saved.expiresAt - EARLY_MS > Date.now()) return saved.accessToken;
		if (saved?.refreshToken) {
			const refreshed = await this.#refresh(saved.refreshToken).catch(() => null);
			if (refreshed) return refreshed.accessToken;
		}
		return (await this.signIn()).accessToken;
	}
	/** After a 401: the token was revoked or expired early. Tries the refresh token, then signing in. */
	async renew() {
		const saved = await this.#load();
		return ((saved?.refreshToken ? await this.#refresh(saved.refreshToken).catch(() => null) : null) ?? await this.signIn()).accessToken;
	}
	/** Signs in through the browser. Only one sign-in at a time. */
	signIn() {
		this.#signingIn ??= this.#signInOnce().finally(() => {
			this.#signingIn = null;
		});
		return this.#signingIn;
	}
	async signOut() {
		const all = await this.#loadAll();
		delete all[this.serverUrl];
		await this.#saveAll(all);
	}
	async #signInOnce() {
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
			state
		}).toString();
		try {
			const code = waitForCode(server, state);
			this.#log(`Sign in to Inklayer in your browser to let the review helper comment as you: ${url}`);
			this.#openUrl(url.toString());
			const tokens = await this.#token({
				grant_type: "authorization_code",
				code: await code,
				redirect_uri: redirectUri,
				code_verifier: verifier
			});
			this.#log("Signed in to Inklayer.");
			return tokens;
		} finally {
			server.closeAllConnections();
			server.close();
		}
	}
	#refresh(refreshToken) {
		return this.#token({
			grant_type: "refresh_token",
			refresh_token: refreshToken
		});
	}
	async #token(form) {
		const response = await this.#fetch(new URL("/connect/token", this.serverUrl), {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				...form,
				client_id: CLIENT_ID
			})
		});
		const body = await response.json().catch(() => ({}));
		if (!response.ok || !body.access_token) throw new Error(`Inklayer didn't sign the helper in: ${body.error_description ?? body.error ?? response.status}`);
		const tokens = {
			accessToken: body.access_token,
			refreshToken: body.refresh_token ?? null,
			expiresAt: Date.now() + (body.expires_in ?? 3600) * 1e3
		};
		const all = await this.#loadAll();
		all[this.serverUrl] = tokens;
		await this.#saveAll(all);
		return tokens;
	}
	async #load() {
		return (await this.#loadAll())[this.serverUrl] ?? null;
	}
	async #loadAll() {
		try {
			return JSON.parse(await readFile(this.#file, "utf8"));
		} catch {
			return {};
		}
	}
	async #saveAll(all) {
		await mkdir(dirname(this.#file), {
			recursive: true,
			mode: 448
		});
		await writeFile(this.#file, `${JSON.stringify(all, null, 2)}\n`, { mode: 384 });
		await chmod(this.#file, 384);
	}
};
/** Listens on the first free port of PORTS (only on this computer). */
async function listenOnFreePort() {
	for (const port of PORTS) {
		const server = createServer();
		if (await new Promise((resolve) => {
			server.once("error", () => resolve(false));
			server.listen(port, "127.0.0.1", () => resolve(true));
		})) return {
			server,
			port
		};
	}
	throw new Error(`Ports ${PORTS.join(", ")} are all in use, so the helper can't receive the sign-in. Free one and try again.`);
}
/** Resolves with the code once the browser comes back to the loopback address with it. */
function waitForCode(server, state) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(/* @__PURE__ */ new Error("Nobody signed in within 5 minutes.")), SIGN_IN_TIMEOUT_MS);
		server.on("request", (request, response) => {
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			if (url.pathname !== "/callback") {
				response.writeHead(404, { Connection: "close" }).end();
				return;
			}
			const page = (message) => response.writeHead(200, {
				"Content-Type": "text/html; charset=utf-8",
				Connection: "close"
			}).end(`<!doctype html><title>Inklayer</title><p style="font:16px system-ui;margin:3em">${message}</p>`);
			const error = url.searchParams.get("error");
			if (url.searchParams.get("state") !== state) {
				page("This sign-in wasn't started by the review helper.");
				return;
			}
			clearTimeout(timer);
			if (error) {
				page("The review helper wasn't allowed. You can close this tab.");
				reject(/* @__PURE__ */ new Error(`Sign-in ended: ${url.searchParams.get("error_description") ?? error}`));
				return;
			}
			page("Signed in. Claude can comment now; you can close this tab.");
			resolve(url.searchParams.get("code") ?? "");
		});
	});
}
function openInBrowser(url) {
	const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
	spawn(command, [url], {
		stdio: "ignore",
		detached: true
	}).on("error", () => void 0).unref();
}
function base64url(bytes) {
	return bytes.toString("base64url");
}
// src/page/clicks.ts
/**
* In recordings, each click shows as a ring that grows and fades where it happened, so people watching the video see
* what was pressed (Playwright's video has no pointer). The helper turns it on for recording contexts by setting
* CLICKS_FLAG before the page loads. Unit-tested: test/clicks.test.ts.
*/
var CLICKS_FLAG = "__inklayerReviewClicks";
// src/browser.ts
/** Recordings stop by themselves after this long, like the extension's: the server takes about a minute of video. */
var MAX_RECORDING_MS = 6e4;
/** How long the sign-in window waits for the person. */
var SIGN_IN_WINDOW_MS = 6e5;
/** How to install the Chromium that this playwright-core needs. */
var INSTALL_BROWSER = `npx -y playwright-core@${createRequire(import.meta.url)("playwright-core/package.json").version} install chromium`;
var DEFAULT_VIEWPORT = {
	width: 1280,
	height: 800
};
/** Most console and network entries kept (the server keeps 20). */
var MAX_ENTRIES = 20;
var MAX_MESSAGE = 500;
var ReviewBrowser = class {
	#options;
	#browser = null;
	#context = null;
	#page = null;
	#viewport = DEFAULT_VIEWPORT;
	#console = [];
	#network = [];
	#recording = null;
	#stopping = null;
	/** Set when a recording stopped at the time limit, until someone asks for it. */
	#autoStopped = false;
	/** The last recording, until a comment takes it or a new one starts. */
	#finished = null;
	constructor(options) {
		this.#options = options;
	}
	/** Recording, or finishing a recording. */
	get recording() {
		return this.#recording !== null || this.#stopping !== null;
	}
	/** The finished recording waiting for a comment, if any. */
	get finishedRecording() {
		return this.#finished;
	}
	get console() {
		return [...this.#console];
	}
	get network() {
		return [...this.#network];
	}
	/** The open page; fails if none is open yet. */
	page() {
		if (!this.#page) throw new Error("No page is open: use open_page first.");
		return this.#page;
	}
	async open(url, viewport) {
		if (viewport && (viewport.width !== this.#viewport.width || viewport.height !== this.#viewport.height)) {
			this.#viewport = viewport;
			await this.#page?.setViewportSize(viewport);
		}
		const page = this.#page ?? await this.#newContext({ state: await this.#savedLogins() });
		await page.goto(url, { waitUntil: "load" });
		await page.waitForLoadState("networkidle", { timeout: 5e3 }).catch(() => void 0);
		await this.#saveLogins();
		return page;
	}
	/**
	* Opens a visible window at `url` for the person to sign in to the site, and waits until they close it. The sign-in
	* is kept for this and later sessions. Returns the address the window ended on.
	*/
	async signInToSite(url) {
		if (this.#recording) throw new Error("Stop recording first.");
		const browser = await launch(false);
		try {
			const context = await browser.newContext({
				viewport: null,
				...await this.#currentState().then((state) => state ? { storageState: state } : {})
			});
			const page = await context.newPage();
			await page.goto(url, { waitUntil: "load" });
			let last = page.url();
			page.on("framenavigated", (frame) => {
				if (frame === page.mainFrame()) last = frame.url();
			});
			let state = await context.storageState();
			const save = async () => {
				state = await context.storageState().catch(() => state);
			};
			const timer = setInterval(() => void save(), 2e3);
			await Promise.race([
				page.waitForEvent("close", { timeout: 0 }),
				new Promise((resolve) => browser.once("disconnected", resolve)),
				new Promise((resolve) => setTimeout(resolve, SIGN_IN_WINDOW_MS))
			]);
			clearInterval(timer);
			await save();
			await this.#switchLogins(state, last);
			return last;
		} finally {
			await browser.close().catch(() => void 0);
		}
	}
	/** Forgets every sign-in to reviewed sites, here and on disk. */
	async forgetLogins() {
		if (this.#options.siteLogins) await rm(this.#options.siteLogins, { force: true });
		await this.#switchLogins(null, this.#page?.url() ?? null);
	}
	/** Starts recording the tab, from the page that's open now (reloaded in a recording context). */
	async startRecording() {
		if (this.#recording) throw new Error("Already recording: use stop_recording first.");
		const url = this.page().url();
		const state = await this.#context?.storageState();
		await this.discardRecording();
		const dir = await mkdtemp(join(tmpdir(), "inklayer-review-"));
		await this.#context?.close();
		const recorded = await this.#newContext({
			dir,
			state
		});
		const timer = setTimeout(() => {
			this.#autoStopped = true;
			this.stopRecording().catch(() => void 0);
		}, MAX_RECORDING_MS);
		timer.unref();
		this.#recording = {
			started: Date.now(),
			dir,
			poster: null,
			timer
		};
		this.#autoStopped = false;
		await recorded.goto(url, { waitUntil: "load" });
		this.#recording.poster = await recorded.screenshot({
			type: "jpeg",
			quality: 70
		}).catch(() => null);
	}
	/** Whether the last recording stopped by itself at the time limit (asked once). */
	takeAutoStopped() {
		const stopped = this.#autoStopped;
		this.#autoStopped = false;
		return stopped;
	}
	/**
	* Stops recording; the video waits for the next comment. The page carries on, no longer recorded. Closing the
	* recording takes a moment (the video is written then): a second call meanwhile waits for the same one.
	*/
	stopRecording() {
		if (this.#stopping) return this.#stopping;
		if (!this.#recording) return Promise.reject(/* @__PURE__ */ new Error("Not recording: use start_recording first."));
		this.#stopping = this.#stop().finally(() => {
			this.#stopping = null;
		});
		return this.#stopping;
	}
	async #stop() {
		const recording = this.#recording;
		if (!recording || !this.#page || !this.#context) throw new Error("Not recording: use start_recording first.");
		clearTimeout(recording.timer);
		const seconds = Math.round((Date.now() - recording.started) / 1e3);
		const page = this.#page;
		const url = page.url();
		const state = await this.#context.storageState();
		const video = page.video();
		await this.#context.close();
		this.#recording = null;
		if (!video) throw new Error("The browser didn't record a video.");
		this.#finished = {
			path: await video.path(),
			seconds,
			poster: recording.poster,
			...this.#viewport
		};
		await this.#saveLogins(state);
		await (await this.#newContext({ state })).goto(url, { waitUntil: "load" }).catch(() => void 0);
		return this.#finished;
	}
	/** Hands the finished recording to a comment (the caller deletes it when done). */
	takeRecording() {
		const taken = this.#finished;
		this.#finished = null;
		return taken;
	}
	async discardRecording() {
		const old = this.takeRecording();
		if (old) await deleteRecording(old);
	}
	async close() {
		if (this.#recording) await this.stopRecording().catch(() => void 0);
		await this.discardRecording();
		await this.#saveLogins().catch(() => void 0);
		await this.#browser?.close();
		this.#browser = null;
		this.#context = null;
		this.#page = null;
	}
	async #newContext(o) {
		this.#browser ??= await launch(this.#options.headless);
		this.#context = await this.#browser.newContext({
			viewport: this.#viewport,
			...o.state ? { storageState: o.state } : {},
			...o.dir ? { recordVideo: {
				dir: o.dir,
				size: this.#viewport
			} } : {}
		});
		if (o.dir) await this.#context.addInitScript(`globalThis[${JSON.stringify(CLICKS_FLAG)}] = true;`);
		await this.#context.addInitScript({ path: this.#options.pageScript });
		this.#page = await this.#context.newPage();
		this.#watch(this.#page);
		return this.#page;
	}
	/** The open page's cookies and storage, else the saved sign-ins. */
	async #currentState() {
		return await this.#context?.storageState().catch(() => null) ?? await this.#savedLogins();
	}
	/** Starts the main tab afresh with these sign-ins (null for none), back at `url`. */
	async #switchLogins(state, url) {
		await this.#saveLogins(state);
		if (!this.#page) return;
		await this.#context?.close();
		const page = await this.#newContext({ state });
		if (url && url !== "about:blank") await page.goto(url, { waitUntil: "load" }).catch(() => void 0);
	}
	async #savedLogins() {
		if (!this.#options.siteLogins) return null;
		try {
			return JSON.parse(await readFile(this.#options.siteLogins, "utf8"));
		} catch {
			return null;
		}
	}
	/** Keeps the sign-ins: `state`, or the open page's if not given; null forgets them. Only the person can read the file. */
	async #saveLogins(state) {
		const file = this.#options.siteLogins;
		if (!file) return;
		const current = state === void 0 ? await this.#context?.storageState().catch(() => void 0) : state;
		if (current === void 0) return;
		if (current === null) {
			await rm(file, { force: true });
			return;
		}
		await mkdir(dirname(file), {
			recursive: true,
			mode: 448
		});
		await writeFile(file, JSON.stringify(current), { mode: 384 });
		await chmod(file, 384);
	}
	/** Keeps the page's recent console errors and warnings, and failed requests, since it last loaded. */
	#watch(page) {
		const now = () => (/* @__PURE__ */ new Date()).toISOString();
		const keep = (list, entry) => {
			list.push(entry);
			if (list.length > MAX_ENTRIES) list.shift();
		};
		page.on("framenavigated", (frame) => {
			if (frame !== page.mainFrame()) return;
			this.#console = [];
			this.#network = [];
		});
		page.on("console", (message) => {
			const level = message.type();
			if (level !== "error" && level !== "warning") return;
			keep(this.#console, {
				level: level === "warning" ? "warn" : level,
				message: message.text().slice(0, MAX_MESSAGE),
				at: now()
			});
		});
		page.on("pageerror", (error) => keep(this.#console, {
			level: "error",
			message: error.message.slice(0, MAX_MESSAGE),
			at: now()
		}));
		page.on("response", (response) => {
			if (response.status() < 400) return;
			const timing = response.request().timing();
			keep(this.#network, {
				method: response.request().method(),
				url: response.url().slice(0, 2e3),
				status: response.status(),
				ms: Math.max(0, Math.round(timing.responseEnd)),
				at: now()
			});
		});
		page.on("requestfailed", (request) => keep(this.#network, {
			method: request.method(),
			url: request.url().slice(0, 2e3),
			status: 0,
			ms: 0,
			at: now()
		}));
	}
};
async function deleteRecording(recording) {
	await rm(join(recording.path, ".."), {
		recursive: true,
		force: true
	}).catch(() => void 0);
}
async function fileSize(path) {
	return (await stat(path)).size;
}
/** Starts Playwright's Chromium, or says how to install it. */
async function launch(headless) {
	try {
		return await chromium.launch({ headless });
	} catch (error) {
		const first = error instanceof Error ? error.message.split("\n")[0] ?? "" : String(error);
		if (!headless && /display|XServer|headed/i.test(first)) throw new Error("There's no screen to show a window on here, so you can't sign in to the site from this session.");
		throw new Error(`Couldn't start Chromium (${first}). Install it with: ${INSTALL_BROWSER}`);
	}
}
// src/mcp.ts
/** Protocol versions this server speaks, newest first. */
var VERSIONS = [
	"2025-11-25",
	"2025-06-18",
	"2025-03-26",
	"2024-11-05"
];
var METHOD_NOT_FOUND = -32601;
var INVALID_PARAMS = -32602;
var PARSE_ERROR = -32700;
var McpServer = class {
	#tools;
	#info;
	#instructions;
	constructor(info, instructions, tools) {
		this.#info = info;
		this.#instructions = instructions;
		this.#tools = new Map(tools.map((t) => [t.name, t]));
	}
	/** Answers one message; null for notifications, which get no answer. */
	async handle(message) {
		if (message.id === void 0 || message.id === null) return null;
		const ok = (result) => ({
			jsonrpc: "2.0",
			id: message.id,
			result
		});
		const fail = (code, text) => ({
			jsonrpc: "2.0",
			id: message.id,
			error: {
				code,
				message: text
			}
		});
		switch (message.method) {
			case "initialize": {
				const asked = String(message.params?.protocolVersion ?? "");
				return ok({
					protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
					capabilities: { tools: {} },
					serverInfo: this.#info,
					instructions: this.#instructions
				});
			}
			case "ping": return ok({});
			case "tools/list": return ok({ tools: [...this.#tools.values()].map((t) => ({
				name: t.name,
				description: t.description,
				inputSchema: t.inputSchema,
				annotations: { readOnlyHint: t.readOnly === true }
			})) });
			case "tools/call": {
				const tool = this.#tools.get(String(message.params?.name ?? ""));
				if (!tool) return fail(INVALID_PARAMS, `Unknown tool: ${String(message.params?.name)}`);
				const args = message.params?.arguments ?? {};
				try {
					return ok({ content: await tool.run(args) });
				} catch (error) {
					return ok({
						content: [{
							type: "text",
							text: errorText(error)
						}],
						isError: true
					});
				}
			}
			default: return fail(METHOD_NOT_FOUND, `Unknown method: ${String(message.method)}`);
		}
	}
	/** Serves on stdin and stdout until stdin closes. Logs go to stderr, which Claude Code keeps out of the protocol. */
	serve(input = process.stdin, output = process.stdout) {
		const write = (reply) => output.write(`${JSON.stringify(reply)}\n`);
		const lines = createInterface({
			input,
			crlfDelay: Number.POSITIVE_INFINITY
		});
		const pending = /* @__PURE__ */ new Set();
		lines.on("line", (line) => {
			if (!line.trim()) return;
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				write({
					jsonrpc: "2.0",
					id: null,
					error: {
						code: PARSE_ERROR,
						message: "Not JSON."
					}
				});
				return;
			}
			const work = this.handle(message).then((reply) => {
				if (reply) write(reply);
			});
			pending.add(work);
			work.finally(() => pending.delete(work));
		});
		return new Promise((resolve) => lines.on("close", () => {
			Promise.all(pending).then(() => resolve());
		}));
	}
};
function errorText(error) {
	return error instanceof Error ? error.message : String(error);
}
var text = (value) => ({
	type: "text",
	text: value
});
var image = (bytes, mimeType = "image/jpeg") => ({
	type: "image",
	data: bytes.toString("base64"),
	mimeType
}), { PI: e } = Math;
e + 1e-4;
var { min: a } = Math;
// ../../packages/overlay/src/pageDetails.ts
var MIN_WIDTH = 480;
var MIN_HEIGHT = 300;
/**
* The part of the visible window to screenshot: the commented area plus a margin, at least a readable size, kept inside
* the window. In CSS pixels; multiply by the device pixel ratio for the captured image.
*/
function screenshotArea(target, viewport) {
	const width = Math.min(viewport.width, Math.max(MIN_WIDTH, target.width + 160));
	const height = Math.min(viewport.height, Math.max(MIN_HEIGHT, target.height + 160));
	const centreX = target.x + target.width / 2;
	const centreY = target.y + target.height / 2;
	const x = Math.min(Math.max(0, centreX - width / 2), viewport.width - width);
	const y = Math.min(Math.max(0, centreY - height / 2), viewport.height - height);
	return {
		x: Math.round(x),
		y: Math.round(y),
		width: Math.round(width),
		height: Math.round(height)
	};
}
function browserOf(userAgent) {
	const version = (name) => new RegExp(`${name}/(\\d+)`).exec(userAgent)?.[1];
	if (version("Edg")) return `Edge ${version("Edg")}`;
	if (version("OPR")) return `Opera ${version("OPR")}`;
	if (version("Firefox")) return `Firefox ${version("Firefox")}`;
	if (version("Chrome")) return `Chrome ${version("Chrome")}`;
	if (version("Version") && /Safari/.test(userAgent)) return `Safari ${version("Version")}`;
	return "Unknown browser";
}
function osOf(userAgent) {
	if (/Windows NT/.test(userAgent)) return "Windows";
	if (/iPhone|iPad/.test(userAgent)) return "iOS";
	if (/Android/.test(userAgent)) return "Android";
	if (/CrOS/.test(userAgent)) return "ChromeOS";
	if (/Mac OS X/.test(userAgent)) return "macOS";
	if (/Linux/.test(userAgent)) return "Linux";
	return "Unknown OS";
}
// src/page/describe.ts
/** What page.js puts on window, for the helper to call. */
var PAGE_GLOBAL = "__inklayerReview";
var MAX_SCREENSHOT_BYTES = 614400;
var MAX_VIDEO_BYTES = 41943040;
/** The project to comment in: the one asked for, or the only one the person can comment in. */
function chooseProject(projects, projectId) {
	const commentable = projects.filter((p) => p.canComment);
	if (projectId) {
		const found = projects.find((p) => p.id === projectId);
		if (!found) throw new Error(`No project ${projectId}. Use list_projects.`);
		if (!found.canComment) throw new Error(`You can't comment in ${found.name} (you're a ${found.myRole}).`);
		return found;
	}
	const [only] = commentable;
	if (commentable.length === 1 && only) return only;
	if (commentable.length === 0) throw new Error("You can't comment in any project: ask an admin for the Commenter role.");
	throw new Error(`Say which project with project_id: ${commentable.map((p) => `${p.name} (${p.organizationName}): ${p.id}`).join("; ")}`);
}
/** What the server needs to place the comment. */
function annotationBody(input, described, url) {
	const pin = input.mark === "pin";
	const address = new URL(url);
	return {
		url,
		kind: pin ? "Pin" : "Element",
		body: input.body,
		color: input.color ?? "#f59e0b",
		anchor: described.anchor,
		geometry: pin ? {
			kind: "Pin",
			point: input.point ?? {
				x: .5,
				y: .5
			}
		} : { kind: "Element" },
		viewportWidth: described.viewport.width,
		includeQuery: input.exactAddress === true && address.search.length > 1,
		includeHash: input.exactAddress === true && address.hash.length > 1
	};
}
/** The page's details, in the shape the server keeps them. */
function pageContext(described, sources) {
	return {
		browser: browserOf(described.userAgent),
		os: osOf(described.userAgent),
		userAgent: described.userAgent,
		viewportWidth: described.viewport.width,
		viewportHeight: described.viewport.height,
		devicePixelRatio: described.devicePixelRatio,
		zoom: 1,
		selector: described.selector,
		elementHtml: described.elementHtml,
		console: sources.console,
		network: sources.network,
		timeZone: described.timeZone,
		utcOffsetMinutes: described.utcOffsetMinutes
	};
}
async function describeElement(page, selector) {
	const element = page.locator(selector).first();
	try {
		await element.scrollIntoViewIfNeeded({ timeout: 5e3 });
	} catch {
		throw new Error(`Nothing on the page matches ${selector}. Use page_outline to find the element.`);
	}
	return element.evaluate((el, name) => window[name]?.describe(el), PAGE_GLOBAL);
}
async function postComment(api, sources, input) {
	if (!input.body.trim()) throw new Error("Write the comment's text in body.");
	const { page } = sources;
	const described = await describeElement(page, input.selector);
	if (!described) throw new Error("The page script isn't loaded: reload the page with open_page.");
	const project = chooseProject(await api.json("GET", "/api/live/projects"), input.projectId);
	const pageUrl = page.url();
	const created = await api.json("POST", `/api/projects/${encodeURIComponent(project.id)}/live/annotations`, annotationBody(input, described, pageUrl));
	const id = encodeURIComponent(created.id);
	const result = {
		id: created.id,
		project,
		pageUrl,
		attached: [],
		problems: []
	};
	const attempt = async (what, work) => {
		try {
			await work();
			result.attached.push(what);
		} catch (error) {
			result.problems.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
		}
	};
	if (input.screenshot !== false) {
		await attempt("screenshot", async () => {
			const area = screenshotArea(described.rect, described.viewport);
			let image = await page.screenshot({
				type: "jpeg",
				quality: 80,
				clip: area
			});
			if (image.length > MAX_SCREENSHOT_BYTES) image = await page.screenshot({
				type: "jpeg",
				quality: 50,
				clip: area
			});
			const scale = described.devicePixelRatio;
			await api.put(`/api/annotations/${id}/screenshot?width=${Math.round(area.width * scale)}&height=${Math.round(area.height * scale)}`, image, "image/jpeg");
		});
		await attempt("page details", () => api.json("PUT", `/api/annotations/${id}/context`, pageContext(described, sources)));
	}
	const recording = input.attachRecording === false ? null : sources.takeRecording();
	if (recording) {
		await attempt(`recording (${recording.seconds}s)`, async () => {
			if (await fileSize(recording.path) > MAX_VIDEO_BYTES) throw new Error("it's over 40 MB; record a shorter one.");
			await api.put(`/api/annotations/${id}/media/video?width=${recording.width}&height=${recording.height}`, await readFile(recording.path), "video/webm");
			if (recording.poster) await api.put(`/api/annotations/${id}/media/thumbnail`, recording.poster, "image/jpeg");
		});
		await deleteRecording(recording);
	}
	return result;
}
// src/tools.ts
/** The tools Claude Code sees. Unit-tested: test/tools.test.ts. */
var INSTRUCTIONS = `Review a web page or feature in a real browser and leave Inklayer comments on it, as the signed-in person.
Open the page with open_page, find elements with page_outline, try things with click, fill, press and scroll, and look with screenshot.
If the site needs a login, sign_in_to_site opens a window for the person to sign in; it's kept for later sessions.
To show a problem in motion, start_recording before the steps and stop_recording after: the next comment gets the video.
Leave each finding with comment, on the element it's about: say what's wrong, the steps, expected and actual.
The first time, Inklayer asks the person to sign in and allow the helper in their browser.
For replies, resolving and reading existing comments, use the Inklayer MCP server's tools.`;
var MAX_OUTLINE = 2e4;
var selector = {
	type: "string",
	description: "A Playwright selector: CSS, text=Save, or role=button[name=\"Save\"]"
};
function reviewTools(api, browser) {
	const shot = async (fullPage = false) => image(await browser.page().screenshot({
		type: "jpeg",
		quality: 70,
		fullPage
	}));
	const where = () => text(`Now on ${browser.page().url()}${browser.recording ? " (recording)" : ""}`);
	return [
		{
			name: "list_projects",
			description: "The Inklayer projects you can see, and whether you can comment in them. Comments go in one.",
			inputSchema: {
				type: "object",
				properties: {}
			},
			readOnly: true,
			run: async () => {
				return [text((await api.json("GET", "/api/live/projects")).map((p) => `${p.name} (${p.organizationName}), ${p.myRole}${p.canComment ? "" : ", can't comment"}: ${p.id}`).join("\n") || "No projects.")];
			}
		},
		{
			name: "open_page",
			description: "Open a page in the review browser (one tab, its own profile). Returns a screenshot.",
			inputSchema: {
				type: "object",
				properties: {
					url: { type: "string" },
					width: {
						type: "number",
						description: "Window width in CSS pixels (default 1280)"
					},
					height: {
						type: "number",
						description: "Window height (default 800)"
					}
				},
				required: ["url"]
			},
			run: async (a) => {
				const width = Number(a.width) || 0;
				const height = Number(a.height) || 0;
				const page = await browser.open(String(a.url), width && height ? {
					width,
					height
				} : void 0);
				return [text(`${await page.title()}: ${page.url()}`), await shot()];
			}
		},
		{
			name: "page_outline",
			description: "The open page's accessibility tree as text (roles, names, text): use it to find elements and write selectors.",
			inputSchema: {
				type: "object",
				properties: {}
			},
			readOnly: true,
			run: async () => {
				const outline = await browser.page().locator("body").ariaSnapshot();
				return [text(outline.length > MAX_OUTLINE ? `${outline.slice(0, MAX_OUTLINE)}\n… (cut)` : outline)];
			}
		},
		{
			name: "screenshot",
			description: "A screenshot of the open page: the window, or the whole page.",
			inputSchema: {
				type: "object",
				properties: { full_page: { type: "boolean" } }
			},
			readOnly: true,
			run: async (a) => [where(), await shot(a.full_page === true)]
		},
		{
			name: "click",
			description: "Click an element.",
			inputSchema: {
				type: "object",
				properties: { selector },
				required: ["selector"]
			},
			run: async (a) => {
				await browser.page().locator(String(a.selector)).first().click({ timeout: 1e4 });
				await settle(browser);
				return [where()];
			}
		},
		{
			name: "fill",
			description: "Type text into a field, replacing what's there.",
			inputSchema: {
				type: "object",
				properties: {
					selector,
					text: { type: "string" }
				},
				required: ["selector", "text"]
			},
			run: async (a) => {
				await browser.page().locator(String(a.selector)).first().fill(String(a.text), { timeout: 1e4 });
				return [where()];
			}
		},
		{
			name: "press",
			description: "Press a key or shortcut (Enter, Tab, Escape, Control+A…), in the focused element.",
			inputSchema: {
				type: "object",
				properties: { key: { type: "string" } },
				required: ["key"]
			},
			run: async (a) => {
				await browser.page().keyboard.press(String(a.key));
				await settle(browser);
				return [where()];
			}
		},
		{
			name: "scroll",
			description: "Scroll an element into view, or the page by some pixels (positive is down).",
			inputSchema: {
				type: "object",
				properties: {
					selector,
					by: { type: "number" }
				}
			},
			run: async (a) => {
				const page = browser.page();
				if (a.selector) await page.locator(String(a.selector)).first().scrollIntoViewIfNeeded({ timeout: 1e4 });
				else await page.mouse.wheel(0, Number(a.by) || 600);
				return [where()];
			}
		},
		{
			name: "sign_in_to_site",
			description: "For sites that need a login: opens a visible browser window at the address for the person to sign in themselves, and waits until they close it (up to 10 minutes). The sign-in is kept for this and later sessions. Tell the person first that a window will open.",
			inputSchema: {
				type: "object",
				properties: { url: { type: "string" } },
				required: ["url"]
			},
			run: async (a) => {
				return [text(`The window closed on ${await browser.signInToSite(String(a.url))}. Its sign-in is kept; the review browser uses it now.`)];
			}
		},
		{
			name: "forget_site_logins",
			description: "Forget every sign-in to reviewed sites that the review browser kept.",
			inputSchema: {
				type: "object",
				properties: {}
			},
			run: async () => {
				await browser.forgetLogins();
				return [text("Forgotten. The review browser is signed out of every site.")];
			}
		},
		{
			name: "start_recording",
			description: `Start recording the tab (the page reloads, staying signed in; clicks show as rings). Do the steps, then stop_recording; the next comment gets the video. It stops by itself after ${MAX_RECORDING_MS / 1e3} seconds.`,
			inputSchema: {
				type: "object",
				properties: {}
			},
			run: async () => {
				await browser.startRecording();
				return [text(`Recording, for up to ${MAX_RECORDING_MS / 1e3} seconds. Do the steps, then stop_recording.`)];
			}
		},
		{
			name: "stop_recording",
			description: "Stop recording. The video is attached to the next comment.",
			inputSchema: {
				type: "object",
				properties: {}
			},
			run: async () => {
				const finished = browser.recording ? await browser.stopRecording() : browser.finishedRecording;
				if (!finished) throw new Error("Not recording: use start_recording first.");
				const limit = browser.takeAutoStopped() ? `, stopping by itself at the ${MAX_RECORDING_MS / 1e3}s limit` : "";
				return [text(`Recorded ${finished.seconds}s${limit}. The next comment gets it.`)];
			}
		},
		{
			name: "comment",
			description: "Leave an Inklayer comment on an element of the open page, as the signed-in person, with a screenshot of it, the page's details (console errors, failed requests) and the last recording.",
			inputSchema: {
				type: "object",
				properties: {
					selector,
					body: {
						type: "string",
						description: "The comment: what's wrong or wanted, steps, expected and actual."
					},
					project_id: {
						type: "string",
						description: "Needed when you can comment in several projects (list_projects)."
					},
					mark: {
						type: "string",
						enum: ["element", "pin"],
						description: "Outline the element (default) or pin a point in it"
					},
					screenshot: {
						type: "boolean",
						description: "Attach a screenshot and page details (default true)"
					},
					attach_recording: {
						type: "boolean",
						description: "Attach the last recording (default true)"
					},
					exact_address: {
						type: "boolean",
						description: "Only for this exact address (with its ?query and #hash), not every version of the page"
					}
				},
				required: ["selector", "body"]
			},
			run: async (a) => {
				const created = await postComment(api, {
					page: browser.page(),
					console: browser.console,
					network: browser.network,
					takeRecording: () => browser.takeRecording()
				}, {
					selector: String(a.selector),
					body: String(a.body ?? ""),
					projectId: a.project_id ? String(a.project_id) : void 0,
					mark: a.mark === "pin" ? "pin" : "element",
					screenshot: a.screenshot !== false,
					attachRecording: a.attach_recording !== false,
					exactAddress: a.exact_address === true
				});
				return [text([
					`Comment ${created.id} saved in ${created.project.name} on ${created.pageUrl}.`,
					created.attached.length > 0 ? `Attached: ${created.attached.join(", ")}.` : "",
					...created.problems.map((p) => `Not attached: ${p}`)
				].filter(Boolean).join("\n"))];
			}
		},
		{
			name: "close_browser",
			description: "Close the review browser (and drop an unused recording).",
			inputSchema: {
				type: "object",
				properties: {}
			},
			run: async () => {
				await browser.close();
				return [text("Closed.")];
			}
		}
	];
}
/** After a click or key: let the page react (navigate, fetch) before the next step. */
async function settle(browser) {
	await browser.page().waitForLoadState("networkidle", { timeout: 3e3 }).catch(() => void 0);
}
// src/main.ts
var flag = process.argv.indexOf("--server");
var serverUrl = (flag >= 0 ? process.argv[flag + 1] : void 0) ?? process.env.INKLAYER_SERVER;
if (!serverUrl?.trim()) {
	process.stderr.write("Set INKLAYER_SERVER (or pass --server <url>) to your Inklayer server's address. From the Claude Code plugin: /plugin configure inklayer@inklayer\n");
	process.exit(1);
}
var api = new Api(new Auth({ serverUrl }));
var browser = new ReviewBrowser({
	pageScript: fileURLToPath(new URL("./page.js", import.meta.url)),
	headless: process.env.INKLAYER_REVIEW_SHOW !== "1",
	siteLogins: siteLogins()
});
await new McpServer({
	name: "inklayer-review",
	version: "0.1.0"
}, INSTRUCTIONS, reviewTools(api, browser)).serve();
await browser.close();
function siteLogins() {
	const set = process.env.INKLAYER_REVIEW_LOGINS;
	if (set === "none") return null;
	return set || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "inklayer", "review-sites.json");
}
export {};
