import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * Reading the client's own source, for the architecture tests: which files there are, what they import, and the CSS
 * classes they define and use. Paths are relative to client/ and use forward slashes.
 */

export const CLIENT_ROOT = resolve(import.meta.dirname, "..");

/** The workspace projects, by folder. */
export const PROJECTS = [
  "packages/api",
  "packages/overlay",
  "packages/ui",
  "apps/extension",
  "apps/viewer",
  "apps/site",
] as const;
export type Project = (typeof PROJECTS)[number];

const SKIP = new Set(["node_modules", "dist", "public"]);

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(relative(CLIENT_ROOT, full).split("\\").join("/"));
  }
  return out;
}

/** Every file under a project's src/ (or the given folder), e.g. "apps/extension/src/live/session.ts". */
export function filesIn(folder: string, extensions: readonly string[]): string[] {
  const root = join(CLIENT_ROOT, folder);
  if (!existsSync(root)) return [];
  return walk(root, []).filter((f) => extensions.some((ext) => f.endsWith(ext)));
}

export const CODE = [".ts", ".tsx"] as const;

/** Every TypeScript source file of every project (tests excluded). */
export function sourceFiles(): string[] {
  return PROJECTS.flatMap((p) => filesIn(`${p}/src`, CODE)).filter((f) => !f.endsWith(".d.ts"));
}

/** The project a file belongs to. */
export function projectOf(file: string): Project | null {
  return PROJECTS.find((p) => file.startsWith(`${p}/`)) ?? null;
}

export function read(file: string): string {
  return readFileSync(join(CLIENT_ROOT, file), "utf8");
}

const IMPORT =
  /(?:^|\n)\s*(?:import|export)\s[^;]*?\sfrom\s+["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

/** The module specifiers a file imports or re-exports from (static, side-effect and dynamic imports). */
export function importsOf(file: string): string[] {
  const text = read(file);
  return [...text.matchAll(IMPORT)].map((m) => m[1] ?? m[2] ?? m[3] ?? "").filter(Boolean);
}

/** A relative import resolved to a client-relative path, without its query (`?inline`) and extension guessing. */
export function resolveRelative(from: string, specifier: string): string {
  const bare = specifier.split("?")[0] ?? specifier;
  return relative(CLIENT_ROOT, resolve(CLIENT_ROOT, dirname(from), bare))
    .split("\\")
    .join("/");
}

/** Whether a resolved import path exists as written, or with a .ts/.tsx/index.ts ending. */
export function exists(path: string): boolean {
  const candidates = [path, `${path}.ts`, `${path}.tsx`, `${path}.d.ts`, `${path}/index.ts`];
  return candidates.some((c) => existsSync(join(CLIENT_ROOT, c)));
}

export function lineCount(file: string): number {
  return read(file).split("\n").length;
}

/** The class names a stylesheet defines (every `.name` in a selector). */
export function classesDefinedIn(css: string): Set<string> {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors = withoutComments.replace(/\{[^{}]*\}/g, "{}"); // drop declarations, keep selectors
  return new Set([...selectors.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1] ?? ""));
}

/** The class names a file sets with `className: "a b"` (DOM builders) or `className="a b"` (JSX string literals). */
export function classesUsedIn(code: string): Set<string> {
  const used = new Set<string>();
  for (const m of code.matchAll(/className(?::\s*|=)"([^"]*)"/g)) {
    for (const name of (m[1] ?? "").split(/\s+/)) if (name) used.add(name);
  }
  return used;
}
