import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Search } from "lucide-react";
import { Badge } from "@inklayer/ui/components/badge";
import { Input } from "@inklayer/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@inklayer/ui/components/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@inklayer/ui/components/table";
import { useMe } from "@/App";
import type { LivePageSummary } from "@/lib/api";
import { dateTime, timeAgo } from "@/lib/format";
import { Link } from "@/lib/router";

type SortKey = "page" | "project" | "open" | "resolved" | "comments" | "issues" | "activity";
type StatusFilter = "all" | "open" | "resolved";
type IssueFilter = "any" | "linked" | "open" | "none";

const total = (p: LivePageSummary) => p.openCount + p.resolvedCount;

const compare: Record<SortKey, (a: LivePageSummary, b: LivePageSummary) => number> = {
  page: (a, b) => a.pageUrl.localeCompare(b.pageUrl),
  project: (a, b) => `${a.organizationName} ${a.projectName}`.localeCompare(`${b.organizationName} ${b.projectName}`),
  open: (a, b) => a.openCount - b.openCount,
  resolved: (a, b) => a.resolvedCount - b.resolvedCount,
  comments: (a, b) => total(a) - total(b),
  // Open issues first, then all issues.
  issues: (a, b) => a.openIssueCount - b.openIssueCount || a.issueCount - b.issueCount,
  activity: (a, b) => a.lastActivityAt.localeCompare(b.lastActivityAt),
};

/**
 * Pages with comments: click a column to sort by it (again to reverse), and filter by status, linked issues or address.
 * Opening a page shows its comments on the page itself, through the extension.
 */
export function PagesTable({ pages, showProject }: { pages: LivePageSummary[]; showProject: boolean }) {
  const { me } = useMe();
  const issues = me.features.issueTrackers;
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "activity", desc: true });
  const [status, setStatus] = useState<StatusFilter>("all");
  const [issueFilter, setIssueFilter] = useState<IssueFilter>("any");
  const [query, setQuery] = useState("");

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = pages.filter((p) =>
      (status === "all" || (status === "open" ? p.openCount > 0 : p.openCount === 0))
      && (!issues || issueFilter === "any" || (issueFilter === "linked" ? p.issueCount > 0 : issueFilter === "open" ? p.openIssueCount > 0 : p.issueCount === 0))
      && (!q || p.pageUrl.toLowerCase().includes(q) || (showProject && `${p.organizationName} ${p.projectName}`.toLowerCase().includes(q))));
    const by = compare[sort.key];
    // Ties keep the most recently active first.
    return rows.sort((a, b) => (sort.desc ? by(b, a) : by(a, b)) || compare.activity(b, a));
  }, [pages, status, issueFilter, query, sort, issues, showProject]);

  const header = (key: SortKey, label: string, className?: string) => {
    const active = sort.key === key;
    const Icon = !active ? ArrowUpDown : sort.desc ? ArrowDown : ArrowUp;
    return (
      <TableHead className={className} aria-sort={active ? (sort.desc ? "descending" : "ascending") : "none"}>
        <button type="button" className="inline-flex items-center gap-1 hover:text-foreground"
          onClick={() => setSort(active ? { key, desc: !sort.desc } : { key, desc: key !== "page" && key !== "project" })}>
          {label}<Icon className={active ? "size-3.5" : "size-3.5 opacity-40"} />
        </button>
      </TableHead>
    );
  };

  const openCount = pages.reduce((n, p) => n + p.openCount, 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder={showProject ? "Filter by address or project" : "Filter by address"} aria-label="Filter pages" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <NativeSelect aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
          <NativeSelectOption value="all">Any status</NativeSelectOption>
          <NativeSelectOption value="open">With open comments</NativeSelectOption>
          <NativeSelectOption value="resolved">All resolved</NativeSelectOption>
        </NativeSelect>
        {issues && (
          <NativeSelect aria-label="Issues" value={issueFilter} onChange={(e) => setIssueFilter(e.target.value as IssueFilter)}>
            <NativeSelectOption value="any">Any issues</NativeSelectOption>
            <NativeSelectOption value="linked">Linked to issues</NativeSelectOption>
            <NativeSelectOption value="open">With open issues</NativeSelectOption>
            <NativeSelectOption value="none">No issues</NativeSelectOption>
          </NativeSelect>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        {shown.length === pages.length ? `${pages.length} page${pages.length === 1 ? "" : "s"}` : `${shown.length} of ${pages.length} pages`} · {openCount} open comment{openCount === 1 ? "" : "s"} in all
      </p>
      <Table className="table-fixed">
        <TableHeader>
          <TableRow>
            {header("page", "Page")}
            {showProject && header("project", "Project", "w-48")}
            {header("open", "Open", "w-20")}
            {header("resolved", "Resolved", "w-24")}
            {header("comments", "Total", "w-20")}
            {issues && header("issues", "Issues", "w-24")}
            {header("activity", "Last activity", "w-36")}
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((p) => (
            <TableRow key={`${p.projectId}:${p.pageUrl}`}>
              <TableCell className="truncate" title={p.pageUrl}>
                <a className="text-primary hover:underline dark:text-violet-300" href={p.pageUrl} target="_blank" rel="noopener noreferrer">{p.pageUrl}</a>
              </TableCell>
              {showProject && (
                <TableCell className="truncate" title={`${p.organizationName} / ${p.projectName}`}>
                  <Link to={`/projects/${p.projectId}`} className="hover:underline">{p.projectName}</Link>
                  <span className="block truncate text-xs text-muted-foreground">{p.organizationName}</span>
                </TableCell>
              )}
              <TableCell>{p.openCount > 0 ? <Badge>{p.openCount}</Badge> : <span className="text-muted-foreground">0</span>}</TableCell>
              <TableCell className="text-muted-foreground">{p.resolvedCount}</TableCell>
              <TableCell className="text-muted-foreground">{total(p)}</TableCell>
              {issues && (
                <TableCell title={p.issueCount ? `${p.openIssueCount} open, ${p.issueCount - p.openIssueCount} closed` : "No issues"}>
                  {p.issueCount === 0 ? <span className="text-muted-foreground">–</span>
                    : p.openIssueCount > 0 ? <Badge variant="outline">{p.openIssueCount} open</Badge>
                    : <span className="text-muted-foreground">{p.issueCount} closed</span>}
                </TableCell>
              )}
              <TableCell className="text-muted-foreground" title={dateTime(p.lastActivityAt)}>{timeAgo(p.lastActivityAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {shown.length === 0 && pages.length > 0 && <p className="text-sm text-muted-foreground">No pages match.</p>}
    </div>
  );
}
