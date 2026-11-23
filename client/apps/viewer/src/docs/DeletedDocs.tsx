import { Button } from "@inklayer/ui/components/button";
import { cn } from "@inklayer/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { ArchiveRestore } from "lucide-react";
import { ErrorText, Loading } from "@/components/Layout";
import { dateTime, timeAgo } from "@/lib/format";
import { personTitle } from "@/lib/people";
import { queries } from "@/lib/queries";
import { useAction } from "@/lib/query";
import { navigate } from "@/lib/router";
import { DocIcon } from "./docIcons";
import { type DeletedDoc, docPath, docsApi } from "./docsApi";

/** Deleted docs, newest first: who deleted each and when, and (for those who can edit) a button to bring it back. */
export function DeletedDocs({ orgId, canEdit }: { orgId: string; canEdit: boolean }) {
  const deleted = useQuery(queries.deletedDocs(orgId));
  const { run, error } = useAction();

  const restore = (doc: DeletedDoc) =>
    run(async () => {
      await docsApi.restore(doc.id);
      navigate(docPath(orgId, doc.id));
    });

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-16 xl:col-span-2">
      <h1 className="font-heading text-2xl font-semibold tracking-tight">Deleted docs</h1>
      <p className="mt-2 text-muted-foreground">
        A deleted doc keeps its text and history.{" "}
        {canEdit
          ? "Restore one to put it back in its folder. Links to it work again."
          : "Commenters and above can restore them."}
      </p>
      <div className="mt-4">
        <ErrorText error={error ?? deleted.error} />
      </div>
      {!deleted.data ? (
        !deleted.error && <Loading />
      ) : deleted.data.length === 0 ? (
        <p className="mt-8 text-sm text-muted-foreground">Nothing has been deleted.</p>
      ) : (
        <ul className="mt-6 divide-y rounded-xl border">
          {deleted.data.map((d) => (
            <li key={d.id} className="flex items-center gap-3 px-3 py-2.5">
              <DocIcon
                icon={d.icon}
                color={d.color}
                className={cn("size-4 shrink-0", !d.color && "text-muted-foreground")}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">
                  {d.title}
                  {d.folder && <span className="ml-2 text-xs font-normal text-muted-foreground">{d.folder}</span>}
                </div>
                <div className="text-xs text-muted-foreground">
                  Deleted by <span title={personTitle(d.deletedBy)}>{d.deletedBy.displayName}</span>{" "}
                  <span title={dateTime(d.deletedAt)}>{timeAgo(d.deletedAt)}</span>
                </div>
              </div>
              {canEdit && (
                <Button variant="outline" size="sm" onClick={() => void restore(d)}>
                  <ArchiveRestore data-icon="inline-start" />
                  Restore
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
