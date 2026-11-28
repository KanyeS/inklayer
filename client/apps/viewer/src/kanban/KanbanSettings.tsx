import { Button } from "@inklayer/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@inklayer/ui/components/dialog";
import { Input } from "@inklayer/ui/components/input";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import type * as Y from "yjs";
import { useMe } from "@/App";
import { ErrorText } from "@/components/Layout";
import { kanbanApi, kanbanQueries } from "./kanbanApi";
import { TrackerSync } from "./TrackerSync";

/** The kanban's key prefix, and its sync with a Jira project. */
export function KanbanSettingsDialog({
  kanbanId,
  doc,
  open,
  onOpenChange,
}: {
  kanbanId: string;
  /** The live kanban, for its columns. */
  doc: Y.Doc;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const settings = useQuery({ ...kanbanQueries.settings(kanbanId), enabled: open });
  const client = useQueryClient();
  const { me } = useMe();
  const [prefix, setPrefix] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (settings.data) setPrefix(settings.data.keyPrefix);
  }, [settings.data]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const next = await kanbanApi.updateSettings(kanbanId, { keyPrefix: prefix });
      client.setQueryData(kanbanQueries.settings(kanbanId).queryKey, next);
      setError(null);
      setSaved(true);
    } catch (err) {
      setError(err as Error);
    }
  };

  const canManage = settings.data?.canManage ?? false;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Kanban settings</DialogTitle>
          <DialogDescription>
            How its tasks are numbered, and whether it stays in step with a Jira project.
          </DialogDescription>
        </DialogHeader>
        <ErrorText error={error ?? settings.error} />
        <form onSubmit={save} className="space-y-2">
          <label className="block text-sm font-medium" htmlFor="kanban-prefix">
            Key prefix
          </label>
          <div className="flex items-center gap-2">
            <Input
              id="kanban-prefix"
              className="w-40 font-mono uppercase"
              value={prefix}
              maxLength={10}
              disabled={!canManage}
              onChange={(e) => {
                setPrefix(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""));
                setSaved(false);
              }}
            />
            <span className="text-sm text-muted-foreground">
              New tasks are {prefix || "…"}-1, {prefix || "…"}-2…
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            2 to 10 capital letters or digits, starting with a letter, and not used by another kanban here. Tasks that
            already have keys keep them.
          </p>
          {canManage && (
            <Button type="submit" size="sm" disabled={!settings.data || prefix === settings.data.keyPrefix}>
              {saved ? "Saved" : "Save"}
            </Button>
          )}
        </form>
        {me.features.issueTrackers && settings.data && (
          <TrackerSync kanbanId={kanbanId} doc={doc} settings={settings.data} canManage={canManage} />
        )}
      </DialogContent>
    </Dialog>
  );
}
