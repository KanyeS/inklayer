/**
 * Which products' comments to show on each site: the products last ticked in the panel's "Showing" menu, per origin, kept
 * in `chrome.storage.local` under {@link SITE_PRODUCTS_KEY}. No entry (or an empty set) means "All products". The most
 * recently changed sites are kept last, and only the newest {@link MAX_SITES} are kept, so the list can't grow forever.
 * <p>Once products have features with URL patterns, the product matching the site will be the default when nothing was picked.</p>
 */

export const SITE_PRODUCTS_KEY = "liveSiteProducts";
export const MAX_SITES = 200;

/** Origin → product ids. (Older versions stored one id as a string; it's read as a set of one.) */
export type SiteProducts = Record<string, string[]>;

function read(stored: unknown): SiteProducts {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
  const entries: [string, string[]][] = [];
  for (const [origin, value] of Object.entries(stored)) {
    const ids =
      typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
    if (ids.length > 0) entries.push([origin, ids]);
  }
  return Object.fromEntries(entries);
}

/** The products picked for `origin` that the user can still see; empty for all products. */
export function siteProductsFor(stored: unknown, origin: string | null, visible: readonly { id: string }[]): string[] {
  if (!origin) return [];
  const ids = read(stored)[origin] ?? [];
  return ids.filter((id) => visible.some((p) => p.id === id));
}

/** The stored map after picking `projectIds` on `origin` (empty: all products, which forgets the site). */
export function rememberSiteProducts(stored: unknown, origin: string, projectIds: readonly string[]): SiteProducts {
  const entries = Object.entries(read(stored)).filter(([o]) => o !== origin);
  if (projectIds.length > 0) entries.push([origin, [...new Set(projectIds)]]);
  return Object.fromEntries(entries.slice(-MAX_SITES));
}
