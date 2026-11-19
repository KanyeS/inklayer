import type { PageContext } from "../lib/live";

/**
 * Pure text helpers for the live panel: addresses, times, counts and summaries. Nothing here touches the DOM or the
 * current page, so all of it is unit-tested directly (test/live-format.test.ts).
 */

/** Which parts of the address a new comment belongs to. Origin and path always; the query and #hash if the commenter chooses. */
export interface Scope {
  query: boolean;
  hash: boolean;
}

export interface ScopeOption {
  scope: Scope;
  label: string;
  /** The part of the address the option covers, e.g. "/watch?v=1". */
  address: string;
}

/** The path as the server keys it: without a trailing slash, except for the root. */
export function pagePath(url: URL): string {
  return url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") || "/" : url.pathname;
}

/** The choices for where a new comment on a page belongs. Only one if the address has no query or #hash. */
export function scopeOptions(href: string): ScopeOption[] {
  const url = new URL(href);
  const path = pagePath(url);
  const query = url.search.length > 1 ? url.search : "";
  const hash = url.hash.length > 1 ? url.hash : "";
  const options: ScopeOption[] = [
    { scope: { query: false, hash: false }, label: "Any version of this page", address: path },
  ];
  if (query) options.push({ scope: { query: true, hash: false }, label: "Only this address", address: path + query });
  if (hash) {
    options.push({
      scope: { query: !!query, hash: true },
      label: query ? "Only this address and #hash" : "Only this #hash",
      address: path + query + hash,
    });
  }
  return options;
}

/** Where an existing comment belongs, for its list entry, e.g. "/watch (any version)" or "/watch?v=…". */
export function addressOf(pageUrl: string | null): string {
  if (!pageUrl) return "";
  try {
    const url = new URL(pageUrl);
    return url.search || url.hash ? pagePath(url) + url.search + url.hash : `${pagePath(url)} (any version)`;
  } catch {
    return pageUrl;
  }
}

/** "just now", "5m ago", "3h ago", "2d ago", "1w ago". */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const units: [number, string][] = [
    [60, "m"],
    [3600, "h"],
    [86400, "d"],
    [604800, "w"],
  ];
  let label = "";
  for (const [size, unit] of units) if (seconds >= size) label = `${Math.floor(seconds / size)}${unit} ago`;
  return label;
}

/** "1 reply", "2 replies": the count with the word in the right form. */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** An unread count for a small badge: "99+" past 99. */
export function badgeCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}

/** A zoom level as a percentage, e.g. 1.25 → "125%". */
export function percent(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

/**
 * The one-line summary of a comment's page details:
 * "Chrome · Windows · 1440×900 at 125% · 2 console errors · 1 failed request".
 */
export function contextSummary(c: PageContext): string {
  const zoomed = c.zoom && Math.abs(c.zoom - 1) > 0.01 ? ` at ${percent(c.zoom)}` : "";
  const errors = c.console.filter((e) => e.level === "error").length;
  return [
    `${c.browser} · ${c.os} · ${c.viewportWidth}×${c.viewportHeight}${zoomed}`,
    errors ? plural(errors, "console error") : "",
    c.network.length ? plural(c.network.length, "failed request") : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** One failed request in the page details, e.g. "GET /api → 500 (120 ms)". */
export function networkLine(n: PageContext["network"][number]): string {
  return `${n.method} ${n.url} → ${n.status || "failed"}${n.ms ? ` (${n.ms} ms)` : ""}`;
}

/** A date for "until …" in the share box, e.g. "4 Mar 2027". */
export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
