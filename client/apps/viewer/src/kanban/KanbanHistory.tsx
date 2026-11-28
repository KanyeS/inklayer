import { Button } from "@inklayer/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@inklayer/ui/components/dialog";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import { ErrorText } from "@/components/Layout";
import { fromBase64 } from "@/docs/collab";
import { RevisionButton } from "@/docs/doc-view/HistoryDialog";
import { type DocRevision, docsApi } from "@/docs/docsApi";
import { queries } from "@/lib/queries";
import { KanbanColumns } from "./KanbanColumns";
import { KanbanContext, type KanbanContextValue, useKanbanContext, useKanbanState } from "./kanbanContext";
import { replaceKanban } from "./kanbanModel";

interface Shown {
  revision: DocRevision;
  kanban: Y.Doc;
}

/** Saved versions of the kanban: see its columns and tasks as they were, and restore one if you can edit. */
export function KanbanHistory({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const context = useKanbanContext();
  const history = useQuery({ ...queries.docHistory(context.kanbanId), enabled: open, staleTime: 0 });
  const [shown, setShown] = useState<Shown | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!open) setShown(null);
  }, [open]);
  useEffect(() => () => shown?.kanban.destroy(), [shown]);

  const show = async (revision: DocRevision) => {
    try {
      const full = await docsApi.revision(context.kanbanId, revision.id);
      const kanban = new Y.Doc();
      if (full.state) Y.applyUpdate(kanban, fromBase64(full.state));
      setShown({ revision, kanban });
      setError(null);
    } catch (e) {
      setError(e as Error);
    }
  };

  const restore = () => {
    if (!shown) return;
    replaceKanban(context.doc, shown.kanban);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl">
        <DialogHeader>
          <DialogTitle>History</DialogTitle>
          <DialogDescription>
            Saved versions of this kanban, at most every few minutes per person. Restoring puts its columns and tasks
            back as they were, for everyone; Ctrl Z undoes it.
          </DialogDescription>
        </DialogHeader>
        <ErrorText error={error ?? history.error} />
        <div className="grid h-[60vh] gap-4 md:grid-cols-[220px_1fr]">
          <ul className="overflow-y-auto">
            {history.data?.map((r) => (
              <li key={r.id}>
                <RevisionButton revision={r} selected={shown?.revision.id === r.id} onClick={() => void show(r)} />
              </li>
            ))}
          </ul>
          <div className="flex min-h-40 flex-col overflow-hidden rounded-xl border bg-muted/30">
            {shown ? (
              <>
                <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
                  <span className="text-sm font-medium">{shown.revision.title}</span>
                  {context.canEdit && (
                    <Button size="sm" variant="outline" onClick={restore}>
                      Restore this version
                    </Button>
                  )}
                </div>
                <Preview key={shown.revision.id} kanban={shown.kanban} parent={context} />
              </>
            ) : (
              <p className="p-3 text-sm text-muted-foreground">Pick a version to see it.</p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Preview({ kanban, parent }: { kanban: Y.Doc; parent: KanbanContextValue }) {
  const state = useKanbanState(kanban);
  const value = useMemo<KanbanContextValue>(
    () => ({ ...parent, doc: kanban, session: null, canEdit: false, openTask: () => undefined }),
    [parent, kanban],
  );
  return (
    <KanbanContext.Provider value={value}>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        <KanbanColumns state={state} visible={() => true} groupBy="none" selected={null} peers={[]} compact />
      </div>
    </KanbanContext.Provider>
  );
}
