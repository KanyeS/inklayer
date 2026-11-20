import { FilePlus2, FolderPlus, Network, Search } from "lucide-react";
import { type DragEvent, useCallback, useEffect, useMemo, useState } from "react";
import { ErrorText } from "@/components/Layout";
import { useAction } from "@/lib/query";
import { Link, navigate } from "@/lib/router";
import { type DocTagInfo, type DocTree, docPath, docsApi } from "../docsApi";
import { rewriteLinks } from "../links";
import { TagPill, tagOf } from "../tags";
import { DocRow, DraftInput, FolderChildren, IconButton } from "./FolderTree";
import {
  buildTree,
  canDropFolder,
  countTags,
  DRAG_DOC,
  DRAG_FOLDER,
  type Draft,
  folderChain,
  isWithin,
  joinPath,
  nameOf,
  parentOf,
} from "./folders";

export interface SidebarProps {
  orgId: string;
  orgName: string;
  tree: DocTree;
  activeId?: string;
  tag: string | null;
  onTag: (tag: string | null) => void;
  onSearch: () => void;
}

/** Which folders are open, remembered per organisation in the browser. Opens the folders down to the doc shown. */
function useOpenFolders(orgId: string, tree: DocTree, activeId: string | undefined) {
  const storageKey = `inklayer.docs.open.${orgId}`;
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(JSON.parse(localStorage.getItem(storageKey) ?? "[]") as string[]),
  );

  const toggle = useCallback(
    (path: string) => {
      setOpen((current) => {
        const next = new Set(current);
        if (!next.delete(path.toLowerCase())) next.add(path.toLowerCase());
        localStorage.setItem(storageKey, JSON.stringify([...next]));
        return next;
      });
    },
    [storageKey],
  );

  const openFolder = useCallback((folder: string) => {
    setOpen((current) => new Set([...current, ...folderChain(folder)]));
  }, []);

  useEffect(() => {
    const doc = tree.docs.find((d) => d.id === activeId);
    if (doc?.folder) openFolder(doc.folder);
  }, [activeId, tree, openFolder]);

  return { open, toggle, openFolder };
}

/**
 * The docs sidebar: the organisation, search and new-doc buttons, the folder tree (or the docs with one tag), and the
 * tags. Docs and folders can be dragged between folders; moving them rewrites links to them.
 */
export function Sidebar({ orgId, orgName, tree, activeId, tag, onTag, onSearch }: SidebarProps) {
  const root = useMemo(() => buildTree(tree), [tree]);
  const { open, toggle, openFolder } = useOpenFolders(orgId, tree, activeId);
  const [draft, setDraft] = useState<Draft>(null);
  const { run, error } = useAction();
  // The server lists tags with counts and their icons and colours; count them here if it didn't.
  const tags = useMemo<DocTagInfo[]>(() => tree.tags ?? countTags(tree.docs), [tree]);

  /** Moves a folder (with everything in it) and rewrites links to the docs that moved. */
  const moveFolder = async (from: string, to: string) => {
    if (from.toLowerCase() === to.toLowerCase()) return;
    const moved = tree.docs.filter((d) => isWithin(d.folder, from));
    const result = await docsApi.moveFolder(orgId, from, to);
    await rewriteLinks(
      result.relinkDocs,
      moved.map((d) => ({ from: d, to: { folder: to + d.folder.slice(from.length), title: d.title } })),
    );
  };

  const moveDoc = (docId: string, folder: string) =>
    run(async () => {
      const info = await docsApi.doc(docId);
      if (info.folder.toLowerCase() === folder.toLowerCase()) return;
      const result = await docsApi.update(docId, { version: info.version, folder });
      await rewriteLinks(result.relinkDocs, [{ from: info, to: { folder, title: info.title } }]);
    });

  const createDoc = async (parent: string, title: string) => {
    const doc = await docsApi.create(orgId, title, parent);
    navigate(docPath(orgId, doc.id));
  };

  const createFolder = async (parent: string, name: string) => {
    await docsApi.createFolder(orgId, joinPath(parent, name));
    if (parent) openFolder(parent);
  };

  /** The name typed in the sidebar's box: create the doc or folder, or rename the folder. */
  const submitDraft = (value: string) => {
    const name = value.trim();
    const current = draft;
    setDraft(null);
    if (!name || !current) return run(async () => undefined);
    if (current.kind === "rename") return run(() => moveFolder(current.path, joinPath(parentOf(current.path), name)));
    if (current.kind === "doc") return run(() => createDoc(current.parent, name));
    return run(() => createFolder(current.parent, name));
  };

  /** A doc or folder dropped on `folder` ("" for the top level). */
  const onDrop = (folder: string) => (e: DragEvent) => {
    e.preventDefault();
    const docId = e.dataTransfer.getData(DRAG_DOC);
    const fromFolder = e.dataTransfer.getData(DRAG_FOLDER);
    if (docId) void moveDoc(docId, folder);
    else if (fromFolder && canDropFolder(fromFolder, folder)) {
      void run(() => moveFolder(fromFolder, joinPath(folder, nameOf(fromFolder))));
    }
  };

  return (
    <aside className="docs-sidebar">
      <div className="flex items-center justify-between gap-2 px-3 pt-4 pb-2">
        <Link
          to={`/orgs/${orgId}`}
          className="truncate font-heading text-sm font-semibold hover:underline"
          title="Organisation"
        >
          {orgName}
        </Link>
        <div className="flex shrink-0 items-center">
          <IconButton title="Search (Ctrl K)" onClick={onSearch}>
            <Search />
          </IconButton>
          <IconButton title="Graph of links" onClick={() => navigate(`/orgs/${orgId}/graph`)}>
            <Network />
          </IconButton>
          {tree.canEdit && (
            <>
              <IconButton title="New doc" onClick={() => setDraft({ kind: "doc", parent: "" })}>
                <FilePlus2 />
              </IconButton>
              <IconButton title="New folder" onClick={() => setDraft({ kind: "folder", parent: "" })}>
                <FolderPlus />
              </IconButton>
            </>
          )}
        </div>
      </div>
      <div className="px-3">
        <ErrorText error={error} />
      </div>

      {tag ? (
        <TaggedDocs orgId={orgId} tree={tree} tag={tag} activeId={activeId} onClear={() => onTag(null)} />
      ) : (
        <nav className="px-2 pb-4" onDragOver={(e) => e.preventDefault()} onDrop={onDrop("")} aria-label="Docs">
          {draft && draft.kind !== "rename" && draft.parent === "" && (
            <DraftInput kind={draft.kind} depth={0} onSubmit={submitDraft} onCancel={() => setDraft(null)} />
          )}
          <FolderChildren
            node={root}
            depth={0}
            orgId={orgId}
            activeId={activeId}
            open={open}
            toggle={toggle}
            draft={draft}
            setDraft={setDraft}
            canEdit={tree.canEdit}
            onSubmitDraft={submitDraft}
            onDrop={onDrop}
            onDeleteFolder={(path) => run(() => docsApi.deleteFolder(orgId, path))}
          />
          {tree.docs.length === 0 && tree.folders.length === 0 && (
            <p className="px-2 py-4 text-sm text-muted-foreground">
              No docs yet.{tree.canEdit && " Create one with the + button."}
            </p>
          )}
        </nav>
      )}

      {tags.length > 0 && <TagList tags={tags} active={tag} onTag={onTag} />}
    </aside>
  );
}

/** The docs with one tag, instead of the folder tree. */
function TaggedDocs({
  orgId,
  tree,
  tag,
  activeId,
  onClear,
}: {
  orgId: string;
  tree: DocTree;
  tag: string;
  activeId?: string;
  onClear: () => void;
}) {
  const docs = tree.docs.filter((d) => d.tags.includes(tag));
  return (
    <div className="px-2 pb-4">
      <div className="mx-1 mb-2 flex items-center justify-between gap-2 px-1 text-sm">
        <span className="text-muted-foreground">Tagged</span>
        <TagPill tag={tagOf(tree, tag)} active onRemove={onClear} />
      </div>
      {docs.map((d) => (
        <DocRow key={d.id} orgId={orgId} doc={d} active={d.id === activeId} depth={0} showFolder />
      ))}
    </div>
  );
}

/** Every tag with its count; click one to show only its docs (again to show all). */
function TagList({
  tags,
  active,
  onTag,
}: {
  tags: DocTagInfo[];
  active: string | null;
  onTag: (tag: string | null) => void;
}) {
  return (
    <div className="border-t px-3 py-4">
      <h2 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Tags</h2>
      <div className="flex flex-wrap gap-1.5">
        {tags.map((t) => (
          <TagPill key={t.tag} tag={t} active={active === t.tag} onClick={() => onTag(active === t.tag ? null : t.tag)}>
            <span className="opacity-60">{t.count}</span>
          </TagPill>
        ))}
      </div>
    </div>
  );
}
