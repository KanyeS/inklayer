import { rememberSiteProducts, SITE_PRODUCTS_KEY } from "../lib/site-products";

/**
 * Which products' comments the panel shows on this site ("Showing"): some products, or all (an empty set). A pick is
 * remembered for the site, so the next visit starts there; a temporary switch (to open a comment in another product) isn't.
 */
export class SiteProduct {
  #ids: ReadonlySet<string>;

  constructor(initial: readonly string[]) {
    this.#ids = new Set(initial);
  }

  /** The products shown; empty when all are. */
  get ids(): ReadonlySet<string> {
    return this.#ids;
  }

  /** Whether `projectId`'s comments are shown. */
  shows(projectId: string): boolean {
    return this.#ids.size === 0 || this.#ids.has(projectId);
  }

  /** The comments of the products shown. */
  shown<T extends { projectId: string }>(all: T[]): T[] {
    return this.#ids.size === 0 ? all : all.filter((a) => this.#ids.has(a.projectId));
  }

  /** Shows `projectIds` (empty: all), remembering it for this site unless `remember` is false. */
  set(projectIds: Iterable<string>, remember = true): void {
    this.#ids = new Set(projectIds);
    if (!remember) return;
    const origin = location.origin;
    const ids = [...this.#ids];
    void chrome.storage.local
      .get(SITE_PRODUCTS_KEY)
      .then((stored) =>
        chrome.storage.local.set({ [SITE_PRODUCTS_KEY]: rememberSiteProducts(stored[SITE_PRODUCTS_KEY], origin, ids) }),
      )
      .catch(() => undefined);
  }
}
