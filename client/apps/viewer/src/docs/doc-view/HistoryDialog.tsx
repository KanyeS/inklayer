import { Button } from "@inklayer/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@inklayer/ui/components/dialog";
import { cn } from "@inklayer/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ErrorText } from "@/components/Layout";
import { dateTime, timeAgo } from "@/lib/format";
import { personTitle } from "@/lib/people";
import { queries } from "@/lib/queries";
import type { DocSession } from "../collab";
import { type DocRevision, docsApi } from "../docsApi";

type ShownRevision = DocRevision & { content: string };

export interface HistoryDialogProps {
  docId: string;
  session: DocSession;
  canEdit: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Saved versions of the doc: pick one to see it, and restore it if you can edit. */
export function HistoryDialog({ docId, session, canEdit, open, onOpenChange }: HistoryDialogProps) {
  // Fetched when the dialog opens, and again each time it does: the doc keeps changing.
  const history = useQuery({ ...queries.docHistory(docId), enabled: open, staleTime: 0 });
  const [shown, setShown] = useState<ShownRevision | null>(null);
  const [error, setError] = useState<Error | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: forget the shown version whenever the dialog opens or closes
  useEffect(() => setShown(null), [open]);

  const show = async (r: DocRevision) => {
    try {
      setShown(await docsApi.revision(docId, r.id));
    } catch (e) {
      setError(e as Error);
    }
  };

  // Restoring is an ordinary edit, so everyone editing sees it and it can be undone.
  const restore = () => {
    if (!shown) return;
    session.doc.transact(() => {
      session.text.delete(0, session.text.length);
      session.text.insert(0, shown.content);
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>History</DialogTitle>
          <DialogDescription>
            Saved versions of this doc. Edits are recorded at most every few minutes per person.
          </DialogDescription>
        </DialogHeader>
        <ErrorText error={error ?? history.error} />
        <div className="grid max-h-[60vh] gap-4 md:grid-cols-[220px_1fr]">
          <ul className="overflow-y-auto">
            {history.data?.map((r) => (
              <li key={r.id}>
                <RevisionButton revision={r} selected={shown?.id === r.id} onClick={() => void show(r)} />
              </li>
            ))}
          </ul>
          <div className="min-h-40 overflow-y-auto rounded-xl border bg-muted/30 p-3">
            {shown ? (
              <RevisionPreview revision={shown} canRestore={canEdit} onRestore={restore} />
            ) : (
              <p className="text-sm text-muted-foreground">Pick a version to see it.</p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RevisionButton({
  revision: r,
  selected,
  onClick,
}: {
  revision: DocRevision;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn("w-full rounded-lg px-2 py-1.5 text-left text-sm hover:bg-muted", selected && "bg-muted")}
      onClick={onClick}
    >
      <span className="block font-medium">
        <span title={personTitle(r.actor)}>{r.actor.displayName}</span> {r.action}
      </span>
      <span className="block text-xs text-muted-foreground" title={dateTime(r.occurredAt)}>
        {timeAgo(r.occurredAt)}
      </span>
    </button>
  );
}

function RevisionPreview({
  revision,
  canRestore,
  onRestore,
}: {
  revision: ShownRevision;
  canRestore: boolean;
  onRestore: () => void;
}) {
  return (
    <>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{revision.title}</span>
        {canRestore && (
          <Button size="sm" variant="outline" onClick={onRestore}>
            Restore this version
          </Button>
        )}
      </div>
      <pre className="text-sm whitespace-pre-wrap">{revision.content || "(empty)"}</pre>
    </>
  );
}
