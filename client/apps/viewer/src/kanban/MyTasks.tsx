import { formatDay } from "@inklayer/ui/components/date-picker";
import { cn } from "@inklayer/ui/lib/utils";
import { useQueries } from "@tanstack/react-query";
import { SquareKanban } from "lucide-react";
import { SectionTitle } from "@/components/Layout";
import { docPath } from "@/docs/docsApi";
import { Link } from "@/lib/router";
import { kanbanQueries, type TaskSummary } from "./kanbanApi";
import { addDays, localDate } from "./kanbanModel";

/** The open tasks assigned to this person, across their organisations' kanbans: overdue first, then by due date. */
export function MyTasks({ orgs }: { orgs: { id: string; name: string }[] }) {
  const results = useQueries({ queries: orgs.map((o) => kanbanQueries.myTasks(o.id)) });
  const seen = new Set<string>();
  const tasks: TaskSummary[] = [];
  for (const r of results) {
    for (const t of r.data ?? []) {
      // A kanban shared with two of their organisations lists its tasks in both.
      const id = `${t.kanbanId}/${t.taskId}`;
      if (!seen.has(id)) {
        seen.add(id);
        tasks.push(t);
      }
    }
  }
  if (tasks.length === 0) return null;

  const today = localDate();
  const week = addDays(today, 7);
  const groups: [string, TaskSummary[]][] = [
    ["Overdue", tasks.filter((t) => t.due && t.due < today)],
    ["Due this week", tasks.filter((t) => t.due && t.due >= today && t.due <= week)],
    ["Later", tasks.filter((t) => t.due && t.due > week)],
    ["No due date", tasks.filter((t) => !t.due)],
  ];
  const byDue = (a: TaskSummary, b: TaskSummary) =>
    (a.due ?? "").localeCompare(b.due ?? "") || a.key.localeCompare(b.key);

  return (
    <section className="mt-10">
      <SectionTitle>My tasks</SectionTitle>
      <div className="space-y-4">
        {groups
          .filter(([, list]) => list.length > 0)
          .map(([title, list]) => (
            <div key={title}>
              <h3
                className={cn(
                  "mb-1 text-sm font-medium",
                  title === "Overdue" ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {title} <span className="tabular-nums">({list.length})</span>
              </h3>
              <ul className="divide-y rounded-xl border">
                {list.sort(byDue).map((t) => (
                  <li key={`${t.kanbanId}/${t.taskId}`}>
                    <Link
                      to={`${docPath(t.organizationId, t.kanbanId)}?task=${encodeURIComponent(t.key)}`}
                      className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-muted/50"
                    >
                      <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">{t.key}</span>
                      <span className="min-w-0 flex-1 truncate">{t.title}</span>
                      <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
                        <SquareKanban className="size-3.5" />
                        {t.kanbanTitle} · {t.column}
                      </span>
                      {t.due && (
                        <span
                          className={cn(
                            "w-16 shrink-0 text-right text-xs tabular-nums",
                            t.due < today && "font-medium text-destructive",
                          )}
                        >
                          {formatDay(t.due)}
                        </span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
      </div>
    </section>
  );
}
