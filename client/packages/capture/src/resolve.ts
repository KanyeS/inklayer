import { escapeStyleText, rewriteCssUrls } from "./css";
import { ResourceRegistry, type ResourceRef } from "./resources";
import type { SerializedPage } from "./serialize";

export interface FetchedResource {
  bytes: Uint8Array;
  /** The response's Content-Type, if any. */
  contentType: string | null;
}

/** Fetches one resource. Returns null if it can't be fetched; the capture continues without it. */
export type ResourceFetcher = (url: string) => Promise<FetchedResource | null>;

export interface CapturedAsset {
  hash: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface ResolvedCapture {
  document: CapturedAsset;
  assets: CapturedAsset[];
  /** URLs that couldn't be fetched (shown to the user; the page is still captured). */
  failed: string[];
}

export interface ResolveOptions {
  maxResources?: number;
  maxCssDepth?: number;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

const UNAVAILABLE = "about:invalid";

/**
 * Turns a serialized page into the final upload. It fetches every placeholder, including the fonts and images that
 * stylesheets reference, inlines the CSS, and replaces each binary placeholder with `a/<sha256>`.
 */
export async function resolveCapture(page: SerializedPage, fetcher: ResourceFetcher, options: ResolveOptions = {}): Promise<ResolvedCapture> {
  const maxResources = options.maxResources ?? 3000;
  const maxCssDepth = options.maxCssDepth ?? 5;
  const concurrency = options.concurrency ?? 6;

  // Rebuild the registry with the same nonce and order, so new resources found in CSS continue the numbering.
  const registry = new ResourceRegistry(page.nonce);
  for (const ref of page.resources) {
    if (registry.register(ref.url, ref.kind) !== ref.token) throw new Error("Resource placeholders are out of order.");
  }

  const binaryReplacement = new Map<string, string>();
  const cssText = new Map<string, string>();
  const assets = new Map<string, CapturedAsset>();
  const failed: string[] = [];
  let next = 0;
  let done = 0;

  const work = async (ref: ResourceRef): Promise<void> => {
    const fetched = await fetcher(ref.url).catch(() => null);
    if (!fetched) {
      failed.push(ref.url);
      if (ref.kind === "binary") binaryReplacement.set(ref.token, UNAVAILABLE);
      else cssText.set(ref.token, "");
      return;
    }

    if (ref.kind === "css") {
      cssText.set(ref.token, rewriteCssUrls(new TextDecoder().decode(fetched.bytes), ref.url, registry));
      return;
    }

    const hash = await sha256Hex(fetched.bytes);
    binaryReplacement.set(ref.token, `a/${hash}`);
    if (!assets.has(hash)) {
      assets.set(hash, { hash, bytes: fetched.bytes, contentType: guessContentType(ref.url, fetched.contentType) });
    }
  };

  // Work through the queue. CSS can register more resources while we go, so keep reading registry.all until it stops growing.
  const runWorker = async (): Promise<void> => {
    for (;;) {
      const all = registry.all;
      if (next >= all.length || next >= maxResources) return;
      const ref = all[next++]!;
      await work(ref);
      options.onProgress?.(++done, Math.min(registry.all.length, maxResources));
    }
  };
  // Waves: workers stop when the queue looks empty, but finished CSS may have added more, so run again until nothing is left.
  while (next < Math.min(registry.all.length, maxResources)) {
    await Promise.all(Array.from({ length: concurrency }, runWorker));
  }

  for (const ref of registry.all.slice(maxResources)) {
    failed.push(ref.url);
    if (ref.kind === "binary") binaryReplacement.set(ref.token, UNAVAILABLE);
    else cssText.set(ref.token, "");
  }

  const pattern = registry.tokenPattern;
  const expand = (text: string, depth: number): string =>
    text.replace(pattern, (token) => {
      const binary = binaryReplacement.get(token);
      if (binary !== undefined) return binary;
      const css = cssText.get(token);
      return css !== undefined && depth < maxCssDepth ? expand(css, depth + 1) : "";
    });

  // In the HTML, CSS placeholders only ever appear inside <style> elements.
  const html = page.html.replace(pattern, (token) => {
    const binary = binaryReplacement.get(token);
    if (binary !== undefined) return binary;
    const css = cssText.get(token);
    return css === undefined ? "" : escapeStyleText(expand(css, 1));
  });

  const documentBytes = new TextEncoder().encode(html);
  return {
    document: { hash: await sha256Hex(documentBytes), contentType: "text/html", bytes: documentBytes },
    assets: [...assets.values()],
    failed,
  };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const EXTENSION_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
  svg: "image/svg+xml", ico: "image/x-icon", bmp: "image/bmp",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf", eot: "application/vnd.ms-fontobject",
  css: "text/css",
};

/** Uses the response's Content-Type unless it's missing or generic, then falls back to the file extension. */
export function guessContentType(url: string, header: string | null): string {
  const type = header?.split(";")[0]?.trim().toLowerCase();
  if (type && type !== "application/octet-stream" && type !== "binary/octet-stream" && type !== "text/plain") return type;
  const ext = new URL(url).pathname.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_TYPES[ext] ?? type ?? "application/octet-stream";
}
