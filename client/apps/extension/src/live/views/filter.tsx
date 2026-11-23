/** @jsxImportSource preact */
import type { ComponentChild } from "preact";
import { useEffect, useRef } from "preact/hooks";
import type { LiveProject } from "../../lib/live";
import type { PageAnnotation } from "../context";
import { icon } from "../icons";

export interface ProductFilterOptions {
  /** Every product the user can see, in any organisation. */
  projects: LiveProject[];
  /** Every comment on the page, to count each product's. */
  annotations: readonly { projectId: string }[];
  /** The products shown; empty when all are. */
  selected: ReadonlySet<string>;
  /** The new selection: product ids, or empty for all products. */
  onChange(projectIds: string[]): void;
  /** How the checklist is narrowed down, remembered across pages and sites. */
  view: ProductMenuView;
  onViewChange(view: ProductMenuView): void;
}

/** "On this page only", and the search box's text (null while it's closed). */
export interface ProductMenuView {
  pageOnly: boolean;
  search: string | null;
}

export const DEFAULT_PRODUCT_MENU_VIEW: ProductMenuView = { pageOnly: false, search: null };

/** A stored {@link ProductMenuView}, or the default for anything else. */
export function readProductMenuView(stored: unknown): ProductMenuView {
  if (!stored || typeof stored !== "object") return DEFAULT_PRODUCT_MENU_VIEW;
  const { pageOnly, search } = stored as Record<string, unknown>;
  return { pageOnly: pageOnly === true, search: typeof search === "string" ? search : null };
}

/**
 * "Showing: All products ▾": which products' comments the page shows. It opens a checklist grouped by organisation, with
 * each product's comments on this page and a tick box per organisation for all of its products. "On this page only" hides
 * products without comments here, and the search icon opens a box that narrows the list by product or organisation name.
 * Only shown when there's more than one product to choose from.
 */
export function productFilter(o: ProductFilterOptions): ComponentChild {
  return o.projects.length < 2 ? null : <ProductFilter {...o} />;
}

function ProductFilter(o: ProductFilterOptions) {
  const menu = useRef<HTMLDetailsElement>(null);
  // Close when clicking anywhere else. The panel is in a closed shadow root, so the page's listeners only see its host:
  // the page closes the menu on clicks outside the panel, and the shadow root on clicks elsewhere in the panel.
  useEffect(() => {
    const details = menu.current;
    if (!details) return;
    const root = details.getRootNode();
    const inside = root instanceof ShadowRoot ? root.host : details;
    const closeUnless = (keep: Node) => (e: Event) => {
      if (details.open && !e.composedPath().includes(keep)) details.open = false;
    };
    const onPage = closeUnless(inside);
    const inPanel = closeUnless(details);
    document.addEventListener("pointerdown", onPage, true);
    if (root !== document) root.addEventListener("pointerdown", inPanel, true);
    return () => {
      document.removeEventListener("pointerdown", onPage, true);
      root.removeEventListener("pointerdown", inPanel, true);
    };
  }, []);

  const { pageOnly, search: query } = o.view;
  const setPageOnly = (on: boolean) => o.onViewChange({ ...o.view, pageOnly: on });
  const setQuery = (text: string | null) => o.onViewChange({ ...o.view, search: text });
  // The box takes the focus when the icon opens it (not when it was left open on another page).
  const search = useRef<HTMLInputElement>(null);
  const opening = useRef(false);
  useEffect(() => {
    if (!opening.current || query === null) return;
    opening.current = false;
    search.current?.focus();
  }, [query]);

  const counts = new Map<string, number>();
  for (const a of o.annotations) counts.set(a.projectId, (counts.get(a.projectId) ?? 0) + 1);
  const words = (query ?? "").trim().toLowerCase();
  const listed = o.projects.filter(
    (p) =>
      (!pageOnly || (counts.get(p.id) ?? 0) > 0) &&
      (!words || `${p.name} ${p.organizationName}`.toLowerCase().includes(words)),
  );
  const orgs = new Map<string, { name: string; projects: LiveProject[] }>();
  for (const p of listed) {
    const org = orgs.get(p.organizationId) ?? { name: p.organizationName, projects: [] };
    org.projects.push(p);
    orgs.set(p.organizationId, org);
  }

  // Everything is ticked when all products are shown; unticking narrows it down. At least one stays ticked.
  const ticked = o.selected.size === 0 ? new Set(o.projects.map((p) => p.id)) : new Set(o.selected);
  const change = (ids: Set<string>) =>
    ids.size > 0 && o.onChange(o.projects.filter((p) => ids.has(p.id)).map((p) => p.id));
  const toggle = (ids: string[], on: boolean) => {
    const next = new Set(ticked);
    for (const id of ids) on ? next.add(id) : next.delete(id);
    change(next);
  };

  const product = (p: LiveProject) => {
    const count = counts.get(p.id) ?? 0;
    const only = ticked.size === 1 && ticked.has(p.id);
    return (
      <label key={p.id} className="choice">
        <input
          type="checkbox"
          checked={ticked.has(p.id)}
          disabled={only}
          title={only ? "At least one product is shown" : undefined}
          onChange={(e) => toggle([p.id], (e.currentTarget as HTMLInputElement).checked)}
        />
        {p.name}
        {count > 0 && <span className="muted"> ({count})</span>}
      </label>
    );
  };

  return (
    <details ref={menu} className="target filter">
      <summary>
        Showing <span className="value">{summary(o.projects, o.selected)}</span>
      </summary>
      <div className="filter-menu">
        <div className="filter-tools">
          <label className="choice page-only">
            <input
              type="checkbox"
              checked={pageOnly}
              onChange={(e) => setPageOnly((e.currentTarget as HTMLInputElement).checked)}
            />
            On this page only
          </label>
          <button
            type="button"
            className={`icon svg search-toggle${query !== null ? " on" : ""}`}
            title={query === null ? "Search products" : "Close search"}
            aria-label={query === null ? "Search products" : "Close search"}
            aria-pressed={query !== null}
            onClick={() => {
              opening.current = query === null;
              setQuery(query === null ? "" : null);
            }}
          >
            {icon("search")}
          </button>
        </div>
        {query !== null && (
          <input
            ref={search}
            type="search"
            className="filter-search"
            placeholder="Search products"
            value={query}
            onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              e.preventDefault();
              e.stopPropagation();
              setQuery(null);
            }}
          />
        )}
        <label className="choice">
          <input type="checkbox" checked={o.selected.size === 0} onChange={() => o.onChange([])} />
          All products
        </label>
        {listed.length === 0 ? (
          <p className="muted filter-empty">{words ? "No products match." : "No product has comments on this page."}</p>
        ) : new Set(o.projects.map((p) => p.organizationId)).size === 1 ? (
          listed.map(product)
        ) : (
          [...orgs.entries()].map(([id, org]) => {
            const ids = org.projects.map((p) => p.id);
            const all = ids.every((i) => ticked.has(i));
            return (
              <fieldset key={id} className="org">
                <label className="choice org-name">
                  <input
                    type="checkbox"
                    checked={all}
                    onChange={() => toggle(ids, !all)}
                    aria-label={`All of ${org.name}`}
                  />
                  {org.name}
                </label>
                {org.projects.map(product)}
              </fieldset>
            );
          })
        )}
      </div>
    </details>
  );
}

/** "All products", "Checkout", "Checkout, Search" or "Checkout + 2 more". */
export function summary(projects: readonly LiveProject[], selected: ReadonlySet<string>): string {
  const names = projects.filter((p) => selected.has(p.id)).map((p) => p.name);
  if (names.length === 0) return "All products";
  return names.length <= 2 ? names.join(", ") : `${names[0]} + ${names.length - 1} more`;
}

export interface CommentListOptions {
  /** Every comment on the page, in any product. */
  all: PageAnnotation[];
  /** The comments of the product shown (or all), resolved or not. */
  shown: PageAnnotation[];
  /** What's listed: `shown`, without resolved ones unless they're being shown. */
  visible: PageAnnotation[];
  showResolved: boolean;
  /** The "Showing" menu, from {@link productFilter}. */
  menu: ComponentChild;
  entry(a: PageAnnotation): ComponentChild;
  onShowAllProducts(): void;
  onToggleResolved(): void;
}

/** "Showing", the page's comments (or why there are none here), and "Show resolved" when some are hidden. */
export function commentList(o: CommentListOptions): ComponentChild[] {
  const resolvedCount = o.shown.filter((a) => a.status !== "Open").length;
  const elsewhere = o.all.length - o.shown.length;
  const list = (
    <ol className="list">
      {o.visible.map((a) => o.entry(a))}
      {o.visible.length === 0 && (
        <li className="empty">
          {o.shown.length ? "No open comments." : "No comments on this page yet."}
          {elsewhere > 0 && (
            <>
              {" "}
              <button type="button" className="link" onClick={o.onShowAllProducts}>
                {elsewhere === 1 ? "1 in another product" : `${elsewhere} in other products`}
              </button>
            </>
          )}
        </li>
      )}
    </ol>
  );
  if (resolvedCount === 0) return [o.menu, list];
  return [
    o.menu,
    list,
    <button key="resolved" type="button" className="link" onClick={o.onToggleResolved}>
      {o.showResolved ? "Hide resolved" : `Show resolved (${resolvedCount})`}
    </button>,
  ];
}
