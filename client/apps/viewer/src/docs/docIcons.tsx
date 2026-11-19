/**
 * Doc icons: any icon from Lucide (the set the rest of the app uses), with a colour, chosen per doc and shown in the
 * graph, the sidebar and the doc's header.
 *
 * Icons are stored by a dashed lowercase name (`book-open`, `bar-chart-3`) worked out from Lucide's own names. The full
 * set is about 2,000 icons, so it's loaded only when a docs page first needs it; until then the default icon shows.
 */

import { FileText } from "lucide-react";
import { type SVGProps, useEffect, useState } from "react";

/** One icon's drawing, as Lucide describes it: SVG elements and their attributes on a 24×24 grid. */
export type IconNode = [tag: string, attrs: Record<string, string | number | undefined>][];

export interface IconEntry {
  /** The stored name, e.g. "book-open". */
  name: string;
  /** Every name the icon goes by (Lucide keeps old names as aliases), for searching. */
  search: string;
  node: IconNode;
}

export interface IconLibrary {
  /** Each icon once, in alphabetical order. */
  all: IconEntry[];
  get(name: string | null | undefined): IconNode | undefined;
}

/** The defaults when nothing is chosen. */
export const DEFAULT_ICONS = { doc: "file-text", comment: "message-square", tag: "hash" } as const;

/** Colours to pick from; any other #rrggbb works too. The first three are the graph's defaults for docs, comments and tags. */
export const ICON_COLORS = [
  "#7c3aed",
  "#e8a100",
  "#0acf83",
  "#2563eb",
  "#0891b2",
  "#16a34a",
  "#65a30d",
  "#ea580c",
  "#dc2626",
  "#db2777",
  "#9333ea",
  "#475569",
];

/** "BarChart3" → "bar-chart-3". Applied to every Lucide name, so lookups only ever compare names made the same way. */
export function iconName(pascal: string): string {
  return pascal
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([a-zA-Z])(\d)/g, "$1-$2")
    .toLowerCase();
}

let loading: Promise<IconLibrary> | null = null;

/** The whole icon set, fetched once. */
export function loadIcons(): Promise<IconLibrary> {
  loading ??= import("lucide").then(({ icons }) => {
    const byName = new Map<string, IconNode>();
    // Aliases share one drawing: list each drawing once, under its first name, searchable by all of them.
    const entries = new Map<IconNode, IconEntry>();
    for (const [pascal, node] of Object.entries(icons) as [string, IconNode][]) {
      const name = iconName(pascal);
      byName.set(name, node);
      const entry = entries.get(node);
      if (entry) entry.search += ` ${name}`;
      else entries.set(node, { name, search: name, node });
    }
    return { all: [...entries.values()], get: (name) => (name ? byName.get(name) : undefined) };
  });
  return loading;
}

/** The icon set once it has loaded (null until then). */
export function useIcons(): IconLibrary | null {
  const [library, setLibrary] = useState<IconLibrary | null>(null);
  useEffect(() => {
    let current = true;
    void loadIcons().then((l) => current && setLibrary(l));
    return () => {
      current = false;
    };
  }, []);
  return library;
}

/** An icon from its drawing, sized and coloured like lucide-react's components. */
export function IconSvg({ node, ...props }: { node: IconNode } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {node.map(([Tag, attrs], i) => (
        <Tag key={i} {...reactAttrs(attrs)} />
      ))}
    </svg>
  );
}

/** A doc's chosen icon in its colour, or the default file icon. */
export function DocIcon({
  icon,
  color,
  className,
}: {
  icon?: string | null;
  color?: string | null;
  className?: string;
}) {
  const library = useIcons();
  const node = library?.get(icon) ?? library?.get(DEFAULT_ICONS.doc);
  const style = color ? { color } : undefined;
  if (!node) return <FileText className={className} style={style} />;
  return <IconSvg node={node} className={className} style={style} />;
}

/** Lucide's attributes are SVG names (stroke-width); React wants camelCase, and only defined values. */
function reactAttrs(attrs: Record<string, string | number | undefined>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined && key !== "key") out[key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = value;
  }
  return out;
}

/** The icon as one canvas path on the 24×24 grid, for the graph, which draws on a canvas. Cached per icon. */
const paths = new WeakMap<IconNode, Path2D>();
export function iconPath(node: IconNode): Path2D {
  let path = paths.get(node);
  if (path) return path;
  path = new Path2D();
  const n = (v: string | number | undefined) => Number(v ?? 0);
  for (const [tag, a] of node) {
    switch (tag) {
      case "path":
        path.addPath(new Path2D(String(a.d)));
        break;
      case "circle":
        path.moveTo(n(a.cx) + n(a.r), n(a.cy));
        path.arc(n(a.cx), n(a.cy), n(a.r), 0, Math.PI * 2);
        break;
      case "ellipse":
        path.moveTo(n(a.cx) + n(a.rx), n(a.cy));
        path.ellipse(n(a.cx), n(a.cy), n(a.rx), n(a.ry), 0, 0, Math.PI * 2);
        break;
      case "rect": {
        const sub = new Path2D();
        sub.roundRect(n(a.x), n(a.y), n(a.width), n(a.height), n(a.rx ?? a.ry));
        path.addPath(sub);
        break;
      }
      case "line":
        path.moveTo(n(a.x1), n(a.y1));
        path.lineTo(n(a.x2), n(a.y2));
        break;
      case "polyline":
      case "polygon": {
        const points = String(a.points)
          .trim()
          .split(/[\s,]+/)
          .map(Number);
        for (let i = 0; i + 1 < points.length; i += 2) {
          if (i === 0) path.moveTo(points[0]!, points[1]!);
          else path.lineTo(points[i]!, points[i + 1]!);
        }
        if (tag === "polygon") path.closePath();
        break;
      }
    }
  }
  paths.set(node, path);
  return path;
}
