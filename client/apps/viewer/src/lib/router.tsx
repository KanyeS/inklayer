import { type AnchorHTMLAttributes, type MouseEvent, useEffect, useState } from "react";

/** A minimal History API router. Routes are matched in App. */
export function usePath(): string {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onChange = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onChange);
    window.addEventListener("inklayer:navigate", onChange);
    return () => {
      window.removeEventListener("popstate", onChange);
      window.removeEventListener("inklayer:navigate", onChange);
    };
  }, []);
  return path;
}

export function navigate(to: string): void {
  if (to === window.location.pathname) return;
  window.history.pushState(null, "", to);
  window.dispatchEvent(new Event("inklayer:navigate"));
  window.scrollTo(0, 0);
}

export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={handle} {...rest} />;
}

/** Matches "/projects/:id" style patterns. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split("/");
  const s = path.replace(/\/+$/, "").split("/");
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i]!.startsWith(":")) params[p[i]!.slice(1)] = decodeURIComponent(s[i]!);
    else if (p[i] !== s[i]) return null;
  }
  return params;
}

/** A page of the app: the address it's at (with :params), and what it needs to be turned on. */
export interface Route<T> {
  pattern: string;
  /** The page is shown only while this is true; otherwise `turnedOff` is (e.g. docs turned off on the server). */
  enabled?: () => boolean;
  page: T;
}

/** The first route whose pattern matches `path` ("/" also matches ""), with the address's :params. */
export function findRoute<T>(
  routes: readonly Route<T>[],
  path: string,
): { route: Route<T>; params: Record<string, string> } | null {
  const clean = path.replace(/\/+$/, "");
  for (const route of routes) {
    const params = route.pattern === "/" ? (clean === "" ? {} : null) : match(route.pattern, clean);
    if (params) return { route, params };
  }
  return null;
}
