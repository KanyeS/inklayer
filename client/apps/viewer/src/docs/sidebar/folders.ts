import type { DocSummary, DocTagInfo, DocTree } from "../docsApi";

/**
 * The docs sidebar's folder tree and the path rules behind it. Folder paths look like "Guides/Setup"; comparisons
 * ignore case, as the server's do. Pure, and unit-tested in test/folders.test.ts.
 */

export interface FolderNode {
  name: string;
  path: string;
  folders: FolderNode[];
  docs: DocSummary[];
}

/** What's being typed in the sidebar: a new doc or folder (in `parent`), or a folder's new name. */
export type Draft =
  | { kind: "doc" | "board" | "kanban" | "folder"; parent: string }
  | { kind: "rename"; path: string }
  | null;

/** Drag-and-drop data types for moving docs and folders. */
export const DRAG_DOC = "application/x-inklayer-doc";
export const DRAG_FOLDER = "application/x-inklayer-folder";

/** How far each level of the tree is indented, in pixels. */
export const INDENT_PX = 12;

/** "a/b" + "c" → "a/b/c"; "" + "c" → "c". */
export function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/** The folder a path is in: "a/b/c" → "a/b"; "c" → "". */
export function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(0, slash) : "";
}

/** The last part of a path: "a/b/c" → "c". */
export function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** A folder and every folder above it, lower-cased: "A/B/C" → ["a", "a/b", "a/b/c"]. */
export function folderChain(folder: string): string[] {
  if (!folder) return [];
  const parts = folder.split("/");
  return parts.map((_, i) =>
    parts
      .slice(0, i + 1)
      .join("/")
      .toLowerCase(),
  );
}

/** Whether `path` is `folder` or inside it (any depth). */
export function isWithin(path: string, folder: string): boolean {
  const p = path.toLowerCase();
  const f = folder.toLowerCase();
  return p === f || p.startsWith(`${f}/`);
}

/** Whether a dragged folder can be dropped into `target`: not into itself or anything inside it. */
export function canDropFolder(dragged: string, target: string): boolean {
  return !isWithin(target, dragged);
}

/** Builds the tree of folders and docs, each level sorted by name. Folders with no docs are kept. */
export function buildTree(tree: Pick<DocTree, "folders" | "docs">): FolderNode {
  const root: FolderNode = { name: "", path: "", folders: [], docs: [] };
  const byPath = new Map<string, FolderNode>([["", root]]);
  const ensure = (path: string): FolderNode => {
    const key = path.toLowerCase();
    const existing = byPath.get(key);
    if (existing) return existing;
    const node: FolderNode = { name: nameOf(path), path, folders: [], docs: [] };
    ensure(parentOf(path)).folders.push(node);
    byPath.set(key, node);
    return node;
  };
  for (const folder of tree.folders) ensure(folder);
  for (const doc of tree.docs) ensure(doc.folder).docs.push(doc);
  const sort = (node: FolderNode) => {
    node.folders.sort((a, b) => a.name.localeCompare(b.name));
    node.docs.sort((a, b) => a.title.localeCompare(b.title));
    for (const child of node.folders) sort(child);
  };
  sort(root);
  return root;
}

/** Tags with how many docs have each, most used first (then by name). */
export function countTags(docs: Pick<DocSummary, "tags">[]): DocTagInfo[] {
  const counts = new Map<string, number>();
  for (const d of docs) for (const t of d.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag, count]) => ({ tag, count }));
}

/** Whether a folder has nothing in it (so it can be deleted). */
export function isEmpty(folder: FolderNode): boolean {
  return folder.docs.length === 0 && folder.folders.length === 0;
}
