import { Button } from "@inklayer/ui/components/button";
import { NativeSelect, NativeSelectOption } from "@inklayer/ui/components/native-select";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Unplug } from "lucide-react";
import { useEffect, useState } from "react";
import type * as Y from "yjs";
import { ErrorText } from "@/components/Layout";
import { timeAgo } from "@/lib/format";
import { CATEGORY_LABELS } from "./KanbanColumns";
import { type KanbanSettings, kanbanApi, kanbanQueries } from "./kanbanApi";
import { readColumns } from "./kanbanModel";

type SyncResult = { pulled: number; pushed: number; created: number; error?: string | null } | null | undefined;

function describe(result: SyncResult): string {
  if (!result) return "Already syncing: try again in a moment.";
  if (result.error) return `Synced, with a problem: ${result.error}`;
  const parts = [
    result.pulled && `${result.pulled} from Jira`,
    result.pushed && `${result.pushed} to Jira`,
    result.created && `${result.created} new in Jira`,
  ].filter(Boolean);
  return parts.length ? `Synced: ${parts.join(", ")}.` : "Synced: nothing had changed.";
}

/** Keeping the kanban in step with a Jira project: connect one, map its statuses to columns, sync now, or stop. */
export function TrackerSync({
  kanbanId,
  doc,
  settings,
  canManage,
}: {
  kanbanId: string;
  doc: Y.Doc;
  settings: KanbanSettings;
  canManage: boolean;
}) {
  const client = useQueryClient();
  const [error, setError] = useState<Error | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const tracker = settings.tracker;
  const save = (next: KanbanSettings) => client.setQueryData(kanbanQueries.settings(kanbanId).queryKey, next);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-4 space-y-2 border-t pt-4">
      <h3 className="font-heading text-sm font-semibold">Sync with Jira</h3>
      <ErrorText error={error} />
      {tracker ? (
        <>
          <p className="text-sm">
            In step with <strong>{tracker.name}</strong> on {tracker.projectName},{" "}
            {tracker.direction === "both" ? "both ways" : "from Jira only"}.{" "}
            <span className="text-muted-foreground">
              {tracker.syncedAt ? `Last synced ${timeAgo(tracker.syncedAt)}.` : "Not synced yet."} It syncs every
              minute.
            </span>
          </p>
          {tracker.syncError && <p className="text-sm text-destructive">{tracker.syncError}</p>}
          {message && <p className="text-sm text-muted-foreground">{message}</p>}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const r = await kanbanApi.syncNow(kanbanId);
                  save(r.settings);
                  setMessage(describe(r.result));
                })
              }
            >
              <RefreshCw data-icon="inline-start" /> Sync now
            </Button>
            {canManage && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    if (!window.confirm("Stop syncing with Jira? Tasks keep their links to their issues.")) return;
                    save(await kanbanApi.disconnectTracker(kanbanId));
                    setMessage("");
                  })
                }
              >
                <Unplug data-icon="inline-start" /> Stop syncing
              </Button>
            )}
          </div>
        </>
      ) : canManage ? (
        <Connect
          kanbanId={kanbanId}
          doc={doc}
          busy={busy}
          run={run}
          onConnected={(next, result) => {
            save(next);
            setMessage(describe(result));
          }}
        />
      ) : (
        <p className="text-sm text-muted-foreground">Not synced with Jira.</p>
      )}
      {!tracker && message && <p className="text-sm text-muted-foreground">{message}</p>}
    </section>
  );
}

function Connect({
  kanbanId,
  doc,
  busy,
  run,
  onConnected,
}: {
  kanbanId: string;
  doc: Y.Doc;
  busy: boolean;
  run: (action: () => Promise<void>) => Promise<void>;
  onConnected: (settings: KanbanSettings, result: SyncResult) => void;
}) {
  const choices = useQuery({
    queryKey: ["kanbans", kanbanId, "tracker-choices"],
    queryFn: () => kanbanApi.trackerChoices(kanbanId),
  });
  const [connectionId, setConnectionId] = useState("");
  const statuses = useQuery({
    queryKey: ["kanbans", kanbanId, "tracker-statuses", connectionId],
    queryFn: () => kanbanApi.trackerStatuses(kanbanId, connectionId),
    enabled: !!connectionId,
  });
  const [map, setMap] = useState<Record<string, string>>({});
  const [direction, setDirection] = useState<"both" | "from-tracker">("both");
  const [addColumns, setAddColumns] = useState(false);
  const [pushExisting, setPushExisting] = useState(false);
  const columns = readColumns(doc);
  useEffect(() => setMap({ ...(statuses.data?.suggestedMap ?? {}) }), [statuses.data]);

  if (choices.data?.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Connect a Jira project to one of this organisation's products first (in the product's settings, under Issue
        trackers), then pick it here.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <ErrorText error={choices.error ?? statuses.error} />
      <NativeSelect
        size="sm"
        aria-label="Jira project"
        value={connectionId}
        onChange={(e) => setConnectionId(e.target.value)}
      >
        <NativeSelectOption value="">Pick a Jira project…</NativeSelectOption>
        {choices.data?.map((c) => (
          <NativeSelectOption key={c.connectionId} value={c.connectionId}>
            {c.projectKey ?? c.name} ({c.projectName})
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {statuses.data && (
        <>
          <p className="text-sm text-muted-foreground">Which column each Jira status goes in:</p>
          <table className="w-full text-sm">
            <tbody>
              {statuses.data.statuses.map((s) => (
                <tr key={s.id}>
                  <td className="py-0.5 pr-2">
                    {s.name} <span className="text-xs text-muted-foreground">({CATEGORY_LABELS[s.category]})</span>
                  </td>
                  <td className="py-0.5">
                    <NativeSelect
                      size="sm"
                      aria-label={`Column for ${s.name}`}
                      value={map[s.id] ?? ""}
                      onChange={(e) => setMap((m) => ({ ...m, [s.id]: e.target.value }))}
                    >
                      {columns.map((c) => (
                        <NativeSelectOption key={c.id} value={c.id}>
                          {c.name}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={addColumns} onChange={(e) => setAddColumns(e.target.checked)} />
            Add a column for each status that has none of its name
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={direction === "both"}
              onChange={(e) => setDirection(e.target.checked ? "both" : "from-tracker")}
            />
            Send changes made here to Jira too (otherwise Jira only sends)
          </label>
          {direction === "both" && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={pushExisting} onChange={(e) => setPushExisting(e.target.checked)} />
              Also create Jira issues for the tasks already here
            </label>
          )}
          <Button
            size="sm"
            disabled={busy || !connectionId}
            onClick={() =>
              void run(async () => {
                const r = await kanbanApi.connectTracker(kanbanId, {
                  connectionId,
                  direction,
                  statusMap: addColumns ? {} : map,
                  addColumns,
                  pushExisting,
                });
                onConnected(r.settings, r.result);
              })
            }
          >
            Connect and sync
          </Button>
          <p className="text-xs text-muted-foreground">
            The open issues (and those done in the last 30 days) come in as tasks. People are matched by email; deleting
            on either side is never synced.
          </p>
        </>
      )}
    </div>
  );
}
