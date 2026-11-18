/** A file the page needs that must be fetched and stored as a snapshot asset. */
export interface ResourceRef {
  /** Placeholder written into the HTML/CSS; replaced by `a/<sha256>` (or CSS text) once fetched. */
  token: string;
  /** Absolute URL to fetch. */
  url: string;
  /** `css` resources are fetched as text, rewritten and inlined into a `<style>`; `binary` ones become assets. */
  kind: "binary" | "css";
}

/**
 * Hands out one placeholder per distinct (url, kind). Each placeholder contains a random per-capture nonce,
 * so text that happens to appear on the page can never be mistaken for one.
 */
export class ResourceRegistry {
  readonly #byKey = new Map<string, ResourceRef>();
  readonly #nonce: string;

  constructor(nonce: string) {
    if (!/^[a-z0-9]{6,32}$/.test(nonce)) throw new Error("nonce must be 6-32 lower-case alphanumerics");
    this.#nonce = nonce;
  }

  get nonce(): string {
    return this.#nonce;
  }

  /** Matches every placeholder of this capture; group 1 is the placeholder's number. */
  get tokenPattern(): RegExp {
    return new RegExp(`ilr-${this.#nonce}-(\\d+)`, "g");
  }

  register(url: string, kind: ResourceRef["kind"]): string {
    const key = `${kind} ${url}`;
    let ref = this.#byKey.get(key);
    if (!ref) {
      ref = { token: `ilr-${this.#nonce}-${this.#byKey.size}`, url, kind };
      this.#byKey.set(key, ref);
    }
    return ref.token;
  }

  get all(): ResourceRef[] {
    return [...this.#byKey.values()];
  }
}

/** Resolves `raw` against `base`. Returns null for URLs that aren't fetchable files (data:, javascript:, fragments, garbage). */
export function resolveFetchableUrl(raw: string | null | undefined, base: string): string | null {
  const value = raw?.trim();
  if (!value || value.startsWith("#")) return null;
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return null;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
}

export function createNonce(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
