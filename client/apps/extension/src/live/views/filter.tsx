/** @jsxImportSource preact */
import type { ComponentChild } from "preact";
import { useEffect, useRef } from "preact/hooks";
import type { LiveProject } from "../../lib/live";
import type { PageAnnotation } from "../context";

export interface ProductFilterOptions {
  /** Every product the user can see, in any organisation. */
  projects: LiveProject[];
  /** Every comment on the page, to count each product's. */
  annotations: readonly { projectId: string }[];
  /** The products shown; empty when all are. */
  selected: ReadonlySet<string>;
  /** The new selection: product ids, or empty for all products. */
  onChange(projectIds: string[]): void;
}

/**
 * "Showing: All products ▾": which products' comments the page shows. It opens a checklist grouped by organisation, with
 * each product's comments on this page and a tick box per organisation for all of its products. Only shown when there's
 * more than one product to choose from.
 */
export function productFilter(o: ProductFilterOptions): ComponentChild {
  return o.projects.length < 2 ? null : <ProductFilter {...o} />;
}

function ProductFilter(o: ProductFilterOptions) {
  const menu = useRef<HTMLDetailsElement>(null);
  // Close when clicking anywhere else (the panel is in a shadow root, so check the event's path).
  useEffect(() => {
    const close = (e: Event) => {
      if (menu.current?.open && !e.composedPath().includes(menu.current)) menu.current.open = false;
    };
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, []);

  const counts = new Map<string, number>();
  for (const a of o.annotations) counts.set(a.projectId, (counts.get(a.projectId) ?? 0) + 1);
  const orgs = new Map<string, { name: string; projects: LiveProject[] }>();
  for (const p of o.projects) {
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
        <label className="choice">
          <input type="checkbox" checked={o.selected.size === 0} onChange={() => o.onChange([])} />
          All products
        </label>
        {orgs.size === 1
          ? o.projects.map(product)
          : [...orgs.entries()].map(([id, org]) => {
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
            })}
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
