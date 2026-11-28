import { Button } from "@inklayer/ui/components/button";
import { cn } from "@inklayer/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { useMe } from "@/App";
import { ErrorText, Loading } from "@/components/Layout";
import { queries } from "@/lib/queries";
import { Link } from "@/lib/router";
import { DeletedDocs } from "./DeletedDocs";
import { DocView } from "./DocView";
import { DocIcon } from "./docIcons";
import { type DocTree, docPath } from "./docsApi";
import { QuickSwitcher } from "./QuickSwitcher";
import { Sidebar } from "./sidebar/Sidebar";

// The board canvas (and its drawing library) loads only when a board is opened.
const BoardView = lazy(() => import("../boards/BoardView").then((m) => ({ default: m.BoardView })));

/** Whether a doc in the tree (or shared with the organisation) is a board. */
function isBoard(tree: DocTree, docId: string): boolean {
  return (
    tree.docs.find((d) => d.id === docId)?.kind === "board" ||
    tree.shared?.find((d) => d.id === docId)?.kind === "board"
  );
}

/** Others add and rename docs too: refresh the tree this often. */
const TREE_REFRESH_MS = 30_000;

/**
 * The docs area of an organisation, laid out like Obsidian: folders and tags on the left, the doc in the middle, its
 * links and history on the right. Ctrl/Cmd+K opens the quick switcher.
 */
export function DocsPage({ orgId, docId, deleted }: { orgId: string; docId?: string; deleted?: boolean }) {
  const org = useQuery(queries.org(orgId));
  // Others add and rename docs too: refresh the tree now and then (only while the tab is visible).
  const tree = useQuery({ ...queries.docTree(orgId), refetchInterval: TREE_REFRESH_MS });
  const [tag, setTag] = useState<string | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const { me } = useMe();

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

  if (tree.error)
    return (
      <div className="p-6">
        <ErrorText error={tree.error} />
      </div>
    );
  if (!tree.data || !org.data)
    return (
      <div className="p-6">
        <Loading />
      </div>
    );

  return (
    <div className="docs-layout">
      <Sidebar
        orgId={orgId}
        orgName={org.data.name}
        tree={tree.data}
        activeId={docId}
        tag={tag}
        onTag={setTag}
        onSearch={() => setSwitcherOpen(true)}
        showingDeleted={deleted}
      />
      {deleted ? (
        <DeletedDocs orgId={orgId} canEdit={tree.data.canEdit} />
      ) : docId && isBoard(tree.data, docId) ? (
        me.features.boards ? (
          <Suspense
            fallback={
              <div className="p-6 xl:col-span-2">
                <Loading />
              </div>
            }
          >
            <BoardView key={docId} orgId={orgId} docId={docId} tree={tree.data} />
          </Suspense>
        ) : (
          <p className="p-6 text-muted-foreground xl:col-span-2">Boards are turned off on this server.</p>
        )
      ) : docId ? (
        <DocView key={docId} orgId={orgId} docId={docId} tree={tree.data} onTag={setTag} />
      ) : (
        <Welcome orgId={orgId} tree={tree.data} onSearch={() => setSwitcherOpen(true)} />
      )}
      <QuickSwitcher orgId={orgId} tree={tree.data} open={switcherOpen} onOpenChange={setSwitcherOpen} onTag={setTag} />
    </div>
  );
}

function Welcome({ orgId, tree, onSearch }: { orgId: string; tree: DocTree; onSearch: () => void }) {
  const recent = [...tree.docs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8);
  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-16 xl:col-span-2">
      <h1 className="font-heading text-2xl font-semibold tracking-tight">Docs</h1>
      <p className="mt-2 text-muted-foreground">
        Notes for everyone in the organisation. Link docs with <code>[[Title]]</code>, tag them with <code>#tag</code>,
        and link page comments too.
      </p>
      <Button variant="outline" className="mt-6" onClick={onSearch}>
        <Search data-icon="inline-start" />
        Find or create a doc <kbd className="ml-2 text-xs text-muted-foreground">Ctrl K</kbd>
      </Button>
      {recent.length > 0 && (
        <>
          <h2 className="mt-10 mb-3 font-heading text-base font-semibold">Recently edited</h2>
          <ul className="space-y-1">
            {recent.map((d) => (
              <li key={d.id}>
                <Link
                  to={docPath(orgId, d.id)}
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-muted"
                >
                  <DocIcon
                    icon={d.icon}
                    kind={d.kind}
                    color={d.color}
                    className={cn("size-4", !d.color && "text-muted-foreground")}
                  />
                  {d.title}
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
