import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight, FilePlus2, FileText, FolderPlus, Folder, Network, Pencil, Search, Trash2, X } from "lucide-react";
import { cn } from "@inklayer/ui/lib/utils";
import { Button } from "@inklayer/ui/components/button";
import { Input } from "@inklayer/ui/components/input";
import { ErrorText, Loading } from "@/components/Layout";
import { get, type Organization } from "@/lib/api";
import { Link, navigate } from "@/lib/router";
import { useAsync } from "@/lib/useAsync";
import { DocView } from "./DocView";
import { docPath, docsApi, type DocSummary, type DocTree } from "./docsApi";
import { pathOf, rewriteLinks } from "./links";
import { QuickSwitcher } from "./QuickSwitcher";

/**
 * The docs area of an organisation, laid out like Obsidian: folders and tags on the left, the doc in the middle, its
 * links and history on the right. Ctrl/Cmd+K opens the quick switcher.
 */
export function DocsPage({ orgId, docId }: { orgId: string; docId?: string }) {
  const org = useAsync(() => get<Organization>(`/api/orgs/${orgId}`), [orgId]);
  const tree = useAsync(() => docsApi.tree(orgId), [orgId]);
  const [tag, setTag] = useState<string | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);

  // Others add and rename docs too: refresh the tree now and then.
  useEffect(() => {
    const timer = window.setInterval(() => document.visibilityState === "visible" && void tree.reload(), 30_000);
    return () => window.clearInterval(timer);
  }, [tree.reload]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSwitcherOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (tree.error) return <div className="p-6"><ErrorText error={tree.error} /></div>;
  if (!tree.data || !org.data) return <div className="p-6"><Loading /></div>;

  return (
    <div className="grid min-h-[calc(100svh-3.5rem)] grid-cols-1 md:grid-cols-[260px_minmax(0,1fr)] xl:grid-cols-[260px_minmax(0,1fr)_300px]">
      <Sidebar
        orgId={orgId}
        orgName={org.data.name}
        tree={tree.data}
        activeId={docId}
        tag={tag}
        onTag={setTag}
        onChanged={tree.reload}
        onSearch={() => setSwitcherOpen(true)}
      />
      {docId ? (
        <DocView key={docId} orgId={orgId} docId={docId} tree={tree.data} onTreeChanged={tree.reload} onTag={setTag} />
      ) : (
        <Welcome orgId={orgId} tree={tree.data} onSearch={() => setSwitcherOpen(true)} />
      )}
      <QuickSwitcher orgId={orgId} tree={tree.data} open={switcherOpen} onOpenChange={setSwitcherOpen} onCreated={tree.reload} />
    </div>
  );
}

function Welcome({ orgId, tree, onSearch }: { orgId: string; tree: DocTree; onSearch: () => void }) {
  const recent = [...tree.docs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8);
  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-16 xl:col-span-2">
      <h1 className="font-heading text-2xl font-semibold tracking-tight">Docs</h1>
      <p className="mt-2 text-muted-foreground">
        Notes for everyone in the organisation. Link docs with <code>[[Title]]</code>, tag them with <code>#tag</code>, and link page comments too.
      </p>
      <Button variant="outline" className="mt-6" onClick={onSearch}><Search data-icon="inline-start" />Find or create a doc <kbd className="ml-2 text-xs text-muted-foreground">Ctrl K</kbd></Button>
      {recent.length > 0 && (
        <>
          <h2 className="mt-10 mb-3 font-heading text-base font-semibold">Recently edited</h2>
          <ul className="space-y-1">
            {recent.map((d) => (
              <li key={d.id}>
                <Link to={docPath(orgId, d.id)} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-muted">
                  <FileText className="size-4 text-muted-foreground" />{d.title}
                  {d.folder && <span className="text-xs text-muted-foreground">{d.folder}</span>}
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ sidebar */

interface FolderNode {
  name: string;
  path: string;
  folders: FolderNode[];
  docs: DocSummary[];
}

function buildTree(tree: DocTree): FolderNode {
  const root: FolderNode = { name: "", path: "", folders: [], docs: [] };
  const byPath = new Map<string, FolderNode>([["", root]]);
  const ensure = (path: string): FolderNode => {
    const key = path.toLowerCase();
    const existing = byPath.get(key);
    if (existing) return existing;
    const slash = path.lastIndexOf("/");
    const parent = ensure(slash >= 0 ? path.slice(0, slash) : "");
    const node: FolderNode = { name: path.slice(slash + 1), path, folders: [], docs: [] };
    parent.folders.push(node);
    byPath.set(key, node);
    return node;
  };
  for (const folder of tree.folders) ensure(folder);
  for (const doc of tree.docs) ensure(doc.folder).docs.push(doc);
  const sort = (node: FolderNode) => {
    node.folders.sort((a, b) => a.name.localeCompare(b.name));
    node.docs.sort((a, b) => a.title.localeCompare(b.title));
    node.folders.forEach(sort);
  };
  sort(root);
  return root;
}

type Draft = { kind: "doc" | "folder"; parent: string } | { kind: "rename"; path: string } | null;

function Sidebar({ orgId, orgName, tree, activeId, tag, onTag, onChanged, onSearch }: {
  orgId: string;
  orgName: string;
  tree: DocTree;
  activeId?: string;
  tag: string | null;
  onTag: (tag: string | null) => void;
  onChanged: () => Promise<void>;
  onSearch: () => void;
}) {
  const root = useMemo(() => buildTree(tree), [tree]);
  const [open, setOpen] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem(`inklayer.docs.open.${orgId}`) ?? "[]") as string[]));
  const [draft, setDraft] = useState<Draft>(null);
  const [error, setError] = useState<Error | null>(null);
  const tags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const d of tree.docs) for (const t of d.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [tree]);

  const toggle = useCallback((path: string) => {
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(path.toLowerCase())) next.add(path.toLowerCase());
      localStorage.setItem(`inklayer.docs.open.${orgId}`, JSON.stringify([...next]));
      return next;
    });
  }, [orgId]);

  // Open the folders down to the doc being shown.
  useEffect(() => {
    const doc = tree.docs.find((d) => d.id === activeId);
    if (!doc?.folder) return;
    setOpen((current) => {
      const next = new Set(current);
      const parts = doc.folder.split("/");
      for (let i = 1; i <= parts.length; i++) next.add(parts.slice(0, i).join("/").toLowerCase());
      return next;
    });
  }, [activeId, tree]);

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      setError(null);
    } catch (e) {
      setError(e as Error);
    }
    await onChanged();
  };

  const submitDraft = (value: string) => run(async () => {
    const name = value.trim();
    const current = draft;
    setDraft(null);
    if (!name || !current) return;
    if (current.kind === "rename") {
      const parent = current.path.includes("/") ? current.path.slice(0, current.path.lastIndexOf("/")) : "";
      await moveFolder(current.path, parent ? `${parent}/${name}` : name);
    } else if (current.kind === "doc") {
      const doc = await docsApi.create(orgId, name, current.parent);
      navigate(docPath(orgId, doc.id));
    } else {
      await docsApi.createFolder(orgId, current.parent ? `${current.parent}/${name}` : name);
      if (current.parent) setOpen((o) => new Set(o).add(current.parent.toLowerCase()));
    }
  });

  const moveFolder = async (from: string, to: string) => {
    if (from.toLowerCase() === to.toLowerCase()) return;
    const moved = tree.docs.filter((d) => d.folder.toLowerCase() === from.toLowerCase() || d.folder.toLowerCase().startsWith(`${from.toLowerCase()}/`));
    const result = await docsApi.moveFolder(orgId, from, to);
    await rewriteLinks(result.relinkDocs, moved.map((d) => ({ from: d, to: { folder: to + d.folder.slice(from.length), title: d.title } })));
  };

  const moveDoc = (docId: string, folder: string) => run(async () => {
    const info = await docsApi.doc(docId);
    if (info.folder.toLowerCase() === folder.toLowerCase()) return;
    const result = await docsApi.update(docId, { version: info.version, folder });
    await rewriteLinks(result.relinkDocs, [{ from: info, to: { folder, title: info.title } }]);
  });

  const onDrop = (folder: string) => (e: DragEvent) => {
    e.preventDefault();
    const docId = e.dataTransfer.getData("application/x-inklayer-doc");
    const fromFolder = e.dataTransfer.getData("application/x-inklayer-folder");
    if (docId) void moveDoc(docId, folder);
    else if (fromFolder && !(`${folder}/`.toLowerCase().startsWith(`${fromFolder}/`.toLowerCase()))) {
      const name = fromFolder.slice(fromFolder.lastIndexOf("/") + 1);
      void run(() => moveFolder(fromFolder, folder ? `${folder}/${name}` : name));
    }
  };

  const filtered = tag ? tree.docs.filter((d) => d.tags.includes(tag)) : null;

  return (
    <aside className="border-b bg-muted/30 md:sticky md:top-14 md:h-[calc(100svh-3.5rem)] md:overflow-y-auto md:border-r md:border-b-0">
      <div className="flex items-center justify-between gap-2 px-3 pt-4 pb-2">
        <Link to={`/orgs/${orgId}`} className="truncate font-heading text-sm font-semibold hover:underline" title="Organisation">{orgName}</Link>
        <div className="flex shrink-0 items-center">
          <IconButton title="Search (Ctrl K)" onClick={onSearch}><Search /></IconButton>
          <IconButton title="Graph of links" onClick={() => navigate(`/orgs/${orgId}/graph`)}><Network /></IconButton>
          {tree.canEdit && <IconButton title="New doc" onClick={() => setDraft({ kind: "doc", parent: "" })}><FilePlus2 /></IconButton>}
          {tree.canEdit && <IconButton title="New folder" onClick={() => setDraft({ kind: "folder", parent: "" })}><FolderPlus /></IconButton>}
        </div>
      </div>
      <div className="px-3"><ErrorText error={error} /></div>

      {filtered ? (
        <div className="px-2 pb-4">
          <div className="mx-1 mb-1 flex items-center justify-between rounded-lg bg-primary/10 px-2 py-1 text-sm">
            <span>#{tag}</span>
            <button type="button" className="text-muted-foreground hover:text-foreground" title="Show all docs" onClick={() => onTag(null)}><X className="size-4" /></button>
          </div>
          {filtered.map((d) => <DocRow key={d.id} orgId={orgId} doc={d} active={d.id === activeId} depth={0} showFolder />)}
        </div>
      ) : (
        <nav
          className="px-2 pb-4"
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop("")}
          aria-label="Docs"
        >
          {draft && draft.kind !== "rename" && draft.parent === "" && <DraftInput kind={draft.kind} depth={0} onSubmit={submitDraft} onCancel={() => setDraft(null)} />}
          <FolderChildren
            node={root} depth={0} orgId={orgId} activeId={activeId} open={open} toggle={toggle} draft={draft} setDraft={setDraft}
            canEdit={tree.canEdit} onSubmitDraft={submitDraft} onDrop={onDrop}
            onDeleteFolder={(path) => run(() => docsApi.deleteFolder(orgId, path))}
          />
          {tree.docs.length === 0 && tree.folders.length === 0 && (
            <p className="px-2 py-4 text-sm text-muted-foreground">No docs yet.{tree.canEdit && " Create one with the + button."}</p>
          )}
        </nav>
      )}

      {tags.length > 0 && (
        <div className="border-t px-3 py-4">
          <h2 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Tags</h2>
          <div className="flex flex-wrap gap-1.5">
            {tags.map(([t, count]) => (
              <button
                key={t}
                type="button"
                onClick={() => onTag(tag === t ? null : t)}
                className={cn("rounded-full px-2 py-0.5 text-xs", tag === t ? "bg-primary text-primary-foreground" : "bg-primary/10 text-primary hover:bg-primary/20")}
              >
                #{t} <span className="opacity-70">{count}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}

function FolderChildren(props: {
  node: FolderNode;
  depth: number;
  orgId: string;
  activeId?: string;
  open: Set<string>;
  toggle: (path: string) => void;
  draft: Draft;
  setDraft: (draft: Draft) => void;
  canEdit: boolean;
  onSubmitDraft: (value: string) => void;
  onDrop: (folder: string) => (e: DragEvent) => void;
  onDeleteFolder: (path: string) => void;
}) {
  const { node, depth, orgId, activeId, open, toggle, draft, setDraft, canEdit, onSubmitDraft, onDrop, onDeleteFolder } = props;
  return (
    <>
      {node.folders.map((folder) => {
        const isOpen = open.has(folder.path.toLowerCase());
        const renaming = draft?.kind === "rename" && draft.path === folder.path;
        return (
          <div key={folder.path}>
            {renaming ? (
              <DraftInput kind="folder" depth={depth} initial={folder.name} onSubmit={onSubmitDraft} onCancel={() => setDraft(null)} />
            ) : (
              <div
                className="group flex items-center rounded-md hover:bg-muted"
                style={{ paddingLeft: depth * 12 }}
                draggable={canEdit}
                onDragStart={(e) => e.dataTransfer.setData("application/x-inklayer-folder", folder.path)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.stopPropagation();
                  onDrop(folder.path)(e);
                }}
              >
                <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1 text-left text-sm" onClick={() => toggle(folder.path)}>
                  {isOpen ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
                  <Folder className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{folder.name}</span>
                </button>
                {canEdit && (
                  <span className="hidden shrink-0 items-center pr-1 group-hover:flex">
                    <IconButton small title="New doc here" onClick={() => { setDraft({ kind: "doc", parent: folder.path }); if (!isOpen) toggle(folder.path); }}><FilePlus2 /></IconButton>
                    <IconButton small title="New folder here" onClick={() => { setDraft({ kind: "folder", parent: folder.path }); if (!isOpen) toggle(folder.path); }}><FolderPlus /></IconButton>
                    <IconButton small title="Rename" onClick={() => setDraft({ kind: "rename", path: folder.path })}><Pencil /></IconButton>
                    {folder.docs.length === 0 && folder.folders.length === 0 && (
                      <IconButton small title="Delete empty folder" onClick={() => onDeleteFolder(folder.path)}><Trash2 /></IconButton>
                    )}
                  </span>
                )}
              </div>
            )}
            {isOpen && (
              <>
                {draft && draft.kind !== "rename" && draft.parent === folder.path && (
                  <DraftInput kind={draft.kind} depth={depth + 1} onSubmit={onSubmitDraft} onCancel={() => setDraft(null)} />
                )}
                <FolderChildren {...props} node={folder} depth={depth + 1} />
              </>
            )}
          </div>
        );
      })}
      {node.docs.map((doc) => <DocRow key={doc.id} orgId={orgId} doc={doc} active={doc.id === activeId} depth={depth} draggable={canEdit} />)}
    </>
  );
}

function DocRow({ orgId, doc, active, depth, draggable, showFolder }: { orgId: string; doc: DocSummary; active: boolean; depth: number; draggable?: boolean; showFolder?: boolean }) {
  return (
    <Link
      to={docPath(orgId, doc.id)}
      draggable={draggable}
      onDragStart={(e) => e.dataTransfer.setData("application/x-inklayer-doc", doc.id)}
      className={cn("flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm", active ? "bg-primary/12 font-medium text-foreground" : "text-foreground/85 hover:bg-muted")}
      style={{ paddingLeft: depth * 12 + 22 }}
      title={pathOf(doc)}
    >
      <FileText className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{doc.title}</span>
      {showFolder && doc.folder && <span className="ml-auto truncate pl-2 text-xs text-muted-foreground">{doc.folder}</span>}
    </Link>
  );
}

function DraftInput({ kind, depth, initial = "", onSubmit, onCancel }: { kind: "doc" | "folder"; depth: number; initial?: string; onSubmit: (value: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false); // Enter submits; the blur that follows mustn't submit again
  const finish = (submitIt: boolean) => {
    if (done.current) return;
    done.current = true;
    if (submitIt) onSubmit(value);
    else onCancel();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    finish(true);
  };
  return (
    <form onSubmit={submit} className="py-0.5" style={{ paddingLeft: depth * 12 + 4 }}>
      <Input
        autoFocus
        className="h-7 text-sm"
        placeholder={kind === "doc" ? "Doc title" : "Folder name"}
        aria-label={kind === "doc" ? "New doc title" : "Folder name"}
        value={value}
        maxLength={200}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => finish(value.trim() !== "" && value !== initial)}
        onKeyDown={(e) => e.key === "Escape" && finish(false)}
      />
    </form>
  );
}

function IconButton({ title, onClick, children, small }: { title: string; onClick: () => void; children: ReactNode; small?: boolean }) {
  return (
    <Button type="button" variant="ghost" size="icon" className={small ? "size-6 [&_svg]:size-3.5" : "size-8"} title={title} aria-label={title} onClick={onClick}>
      {children}
    </Button>
  );
}
