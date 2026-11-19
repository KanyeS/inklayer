import { relinkEdits, type WikiLink } from "@inklayer/docs/docMarkdown";
import { editDoc } from "./collab";
import { type DocSummary, docsApi } from "./docsApi";

/** Finds the doc a link means, with the server's rules: [[Folder/Title]] by path; [[Title]] by title, top level first. */
export function resolveLink(docs: DocSummary[], link: WikiLink): DocSummary | null {
  if (!link.target) return null;
  const key = link.target.toLowerCase();
  if (key.includes("/")) return docs.find((d) => pathOf(d).toLowerCase() === key) ?? null;
  const matches = docs.filter((d) => d.title.toLowerCase() === key);
  return (
    matches.sort(
      (a, b) => Number(a.folder !== "") - Number(b.folder !== "") || pathOf(a).localeCompare(pathOf(b)),
    )[0] ?? null
  );
}

export const pathOf = (d: { folder: string; title: string }) => (d.folder ? `${d.folder}/${d.title}` : d.title);

/** Creates the doc a link names (in its folder, if it has one) and returns it. */
export function createFromLink(orgId: string, target: string): Promise<DocSummary> {
  const slash = target.lastIndexOf("/");
  return docsApi.create(orgId, slash >= 0 ? target.slice(slash + 1) : target, slash >= 0 ? target.slice(0, slash) : "");
}

/**
 * After docs were renamed or moved, rewrites the links in the docs the server listed, so they keep pointing at them.
 * `moves` maps each doc's old place to its new one. Links by path follow the new path; links by title follow a new title.
 */
export async function rewriteLinks(
  relinkDocs: string[],
  moves: { from: { folder: string; title: string }; to: { folder: string; title: string } }[],
): Promise<void> {
  const byPath = new Map(moves.map((m) => [pathOf(m.from).toLowerCase(), m.to]));
  const byTitle = new Map(
    moves.filter((m) => m.from.title !== m.to.title).map((m) => [m.from.title.toLowerCase(), m.to]),
  );
  const targetFor = (link: WikiLink) => {
    const key = link.target!.toLowerCase();
    const to = key.includes("/") ? byPath.get(key) : byTitle.get(key);
    return key.includes("/") ? pathOf(to!) : to!.title;
  };
  const matches = (key: string) => (key.includes("/") ? byPath.has(key) : byTitle.has(key));

  for (const docId of relinkDocs) {
    await editDoc(docId, (text) => {
      for (const edit of relinkEdits(text.toString(), matches, targetFor)) {
        text.delete(edit.from, edit.to - edit.from);
        text.insert(edit.from, edit.insert);
      }
    }).catch(() => undefined);
  }
}
