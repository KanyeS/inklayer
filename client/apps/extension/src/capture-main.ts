/**
 * Page details for bug reports: recent console errors and warnings, uncaught errors, and failed requests.
 *
 * Runs in the page's own JavaScript world from the start of loading, because that's the only place these can be seen.
 * It only remembers the last few of each, in the page's memory: nothing is sent anywhere. When someone saves a comment
 * (with "Attach screenshot and page details" on), the extension's live script asks for them through a DOM event.
 *
 * URLs are kept without their query string or #hash, which can hold tokens. Messages are cut to 500 characters.
 */

declare global {
  var __inklayerCapture: boolean | undefined;
}

interface ConsoleEntry {
  level: string;
  message: string;
  at: string;
}

interface NetworkEntry {
  method: string;
  url: string;
  status: number;
  ms: number;
  at: string;
}

const KEEP = 20;
const MAX_MESSAGE = 500;

/** Inklayer's panel and hover bubbles, as the page sees them (their insides are in closed shadow roots). */
const OUR_HOSTS = new Set(["INKLAYER-LIVE", "INKLAYER-BUBBLES"]);

/**
 * Whether a key press is someone typing in Inklayer's panel or bubbles: a plain character (a letter, a space) with no
 * Ctrl, Cmd or Alt. Exported for tests.
 */
export function isTypingInInklayer(e: KeyboardEvent): boolean {
  const target = e.composedPath()[0] as Element | undefined;
  return !!target && OUR_HOSTS.has(target.tagName) && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
}

if (!globalThis.__inklayerCapture) {
  globalThis.__inklayerCapture = true;

  // Sites' keyboard shortcuts (YouTube's space for play/pause) catch keys on the way in and stop them, so typing in
  // Inklayer's boxes would play and pause instead. This runs before the page's own scripts, so it listens first: plain
  // characters typed in Inklayer go no further into the page, and are typed as usual. Other keys pass as normal.
  for (const type of ["keydown", "keypress", "keyup"] as const) {
    window.addEventListener(
      type,
      (e) => {
        if (isTypingInInklayer(e)) e.stopImmediatePropagation();
      },
      true,
    );
  }

  const consoleEntries: ConsoleEntry[] = [];
  const networkEntries: NetworkEntry[] = [];
  const now = () => new Date().toISOString();
  const push = <T>(list: T[], entry: T) => {
    list.push(entry);
    if (list.length > KEEP) list.shift();
  };

  const text = (value: unknown): string => {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  };
  const describe = (args: unknown[]) => args.map(text).join(" ").slice(0, MAX_MESSAGE);
  const withoutQuery = (url: string) => {
    try {
      const parsed = new URL(url, location.href);
      return parsed.origin + parsed.pathname;
    } catch {
      return String(url).split(/[?#]/)[0]!.slice(0, 500);
    }
  };

  // Console errors and warnings, passed on to the page's console as before.
  for (const level of ["error", "warn"] as const) {
    // biome-ignore lint/suspicious/noConsole: wraps the page's console to record errors, then passes them on
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      push(consoleEntries, { level, message: describe(args), at: now() });
      original(...args);
    };
  }

  window.addEventListener("error", (e) => {
    const where = e.filename ? ` (${withoutQuery(e.filename)}:${e.lineno})` : "";
    push(consoleEntries, { level: "error", message: `${e.message}${where}`.slice(0, MAX_MESSAGE), at: now() });
  });
  window.addEventListener("unhandledrejection", (e) => {
    push(consoleEntries, {
      level: "error",
      message: `Unhandled rejection: ${text(e.reason)}`.slice(0, MAX_MESSAGE),
      at: now(),
    });
  });

  // Failed fetches: HTTP errors (4xx/5xx) and network failures (status 0).
  const originalFetch = window.fetch;
  window.fetch = async function fetch(input: RequestInfo | URL, init?: RequestInit) {
    const started = performance.now();
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const url = withoutQuery(input instanceof Request ? input.url : String(input));
    try {
      const response = await originalFetch.call(this, input, init);
      if (!response.ok)
        push(networkEntries, {
          method,
          url,
          status: response.status,
          ms: Math.round(performance.now() - started),
          at: now(),
        });
      return response;
    } catch (error) {
      push(networkEntries, { method, url, status: 0, ms: Math.round(performance.now() - started), at: now() });
      throw error;
    }
  };

  // Failed XMLHttpRequests, the same way.
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  const requests = new WeakMap<XMLHttpRequest, { method: string; url: string; started: number }>();
  XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    requests.set(this, { method: String(method).toUpperCase(), url: withoutQuery(String(url)), started: 0 });
    return (open as (...a: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const info = requests.get(this);
    if (info) {
      info.started = performance.now();
      this.addEventListener("loadend", () => {
        if (this.status === 0 || this.status >= 400) {
          push(networkEntries, {
            method: info.method,
            url: info.url,
            status: this.status,
            ms: Math.round(performance.now() - info.started),
            at: now(),
          });
        }
      });
    }
    return send.call(this, body);
  };

  // The extension's live script asks; strings cross between the two worlds safely.
  document.addEventListener("inklayer:context-request", (e) => {
    const nonce = (e as CustomEvent<unknown>).detail;
    if (typeof nonce !== "string") return;
    document.dispatchEvent(
      new CustomEvent("inklayer:context-response", {
        detail: JSON.stringify({ nonce, console: consoleEntries, network: networkEntries }),
      }),
    );
  });
}
