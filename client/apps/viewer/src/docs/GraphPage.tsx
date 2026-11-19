import { Button } from "@inklayer/ui/components/button";
import { Checkbox } from "@inklayer/ui/components/checkbox";
import { Input } from "@inklayer/ui/components/input";
import { Label } from "@inklayer/ui/components/label";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import { ErrorText, Loading } from "@/components/Layout";
import { Link } from "@/lib/router";
import { useAsync } from "@/lib/useAsync";
import { docsApi } from "./docsApi";
import { GraphCanvas } from "./graph/GraphCanvas";
import { TagPill } from "./tags";

/**
 * The organisation's docs as a graph, like Obsidian's: each doc as its icon in its colour (chosen in the doc's header),
 * sized by how linked it is, and a line per link.
 * Comments that link docs (or are linked from them) and tags can be shown too, and the graph can be narrowed to docs
 * with chosen tags. Drag to pan, scroll to zoom, drag a node to move it, hover to see its neighbours, click to open.
 */
export function GraphPage({ orgId }: { orgId: string }) {
  const graph = useAsync(() => docsApi.graph(orgId), [orgId]);
  const tree = useAsync(() => docsApi.tree(orgId), [orgId]);
  const [showComments, setShowComments] = useState(true);
  const [showTags, setShowTags] = useState(false);
  const [filter, setFilter] = useState("");
  // Only docs with any of these tags; empty for every doc.
  const [onlyTags, setOnlyTags] = useState<ReadonlySet<string>>(new Set());
  const toggleTag = (tag: string) =>
    setOnlyTags((current) => {
      const next = new Set(current);
      if (!next.delete(tag)) next.add(tag);
      return next;
    });

  if (graph.error || tree.error)
    return (
      <div className="p-6">
        <ErrorText error={graph.error ?? tree.error} />
      </div>
    );
  if (!graph.data || !tree.data)
    return (
      <div className="p-6">
        <Loading />
      </div>
    );

  return (
    <div className="relative h-[calc(100svh-3.5rem)] overflow-hidden">
      <div className="graph-controls">
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 self-start"
          nativeButton={false}
          render={<Link to={`/orgs/${orgId}/docs`} />}
        >
          <ArrowLeft data-icon="inline-start" />
          Docs
        </Button>
        <Input
          placeholder="Highlight docs…"
          aria-label="Highlight docs whose title contains"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <Label className="flex items-center gap-2 font-normal">
          <Checkbox checked={showComments} onCheckedChange={(v) => setShowComments(v === true)} />
          Page comments
        </Label>
        <Label className="flex items-center gap-2 font-normal">
          <Checkbox checked={showTags} onCheckedChange={(v) => setShowTags(v === true)} />
          Tags
        </Label>
        {(tree.data.tags?.length ?? 0) > 0 && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Only docs tagged</span>
              {onlyTags.size > 0 && (
                <button type="button" className="hover:text-foreground" onClick={() => setOnlyTags(new Set())}>
                  Clear
                </button>
              )}
            </div>
            <div className="flex max-h-40 flex-wrap gap-1 overflow-y-auto">
              {tree.data.tags!.map((t) => (
                <TagPill key={t.tag} tag={t} active={onlyTags.has(t.tag)} onClick={() => toggleTag(t.tag)} />
              ))}
            </div>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          {onlyTags.size > 0 && `${tree.data.docs.filter((d) => d.tags.some((t) => onlyTags.has(t))).length} of `}
          {graph.data.nodes.filter((n) => n.kind === "doc").length} docs · {graph.data.edges.length} links
        </p>
      </div>
      <GraphCanvas
        orgId={orgId}
        graph={graph.data}
        tree={tree.data}
        showComments={showComments}
        showTags={showTags}
        onlyTags={onlyTags}
        filter={filter}
      />
    </div>
  );
}
