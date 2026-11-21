import type { AccessMapNode, AccessMapResponse } from "@inklayer/api";
import { Badge } from "@inklayer/ui/components/badge";
import { Button } from "@inklayer/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@inklayer/ui/components/dialog";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Building2, KeyRound, Package, User, Users } from "lucide-react";
import { useState } from "react";
import { ErrorText, Loading } from "@/components/Layout";
import type { Role } from "@/lib/api";
import { queries } from "@/lib/queries";
import { navigate } from "@/lib/router";
import { type AccessMapLayout, layoutAccessMap, NODE_HEIGHT, NODE_WIDTH } from "./accessMapLayout";

export type MapSubject = { type: "user" | "team"; id: string };

/** A change to preview before making it: a role on a product, or joining a team. */
export type MapPreview = { addProjectId: string; addRole: Role } | { addTeamId: string };

const KIND_ICON = { Person: User, Team: Users, Direct: KeyRound, Organisation: Building2, Product: Package } as const;

const CHANGE_STYLE = {
  Added: "border-emerald-500 bg-emerald-500/10",
  Raised: "border-amber-500 bg-amber-500/10",
} as const;

/**
 * A dialog showing what a person or team can reach and how, as a flow chart. Clicking a person or team opens their map
 * (Back returns), and clicking a product opens it. With a `preview`, what the change would add or raise is highlighted.
 */
export function AccessMapDialog({
  orgId,
  subject,
  preview,
  title,
  open,
  onOpenChange,
}: {
  orgId: string;
  subject: MapSubject;
  preview?: MapPreview;
  title?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // Drilling into people and teams; the preview applies to the first map only.
  const [trail, setTrail] = useState<MapSubject[]>([]);
  const current = trail.at(-1) ?? subject;
  const map = useQuery({
    ...queries.accessMap(orgId, current.type, current.id, trail.length === 0 ? preview : undefined),
    enabled: open,
  });

  const openNode = (n: AccessMapNode) => {
    if (!n.entityId || `${current.type}:${current.id}` === n.id) return;
    if (n.kind === "Product") {
      onOpenChange(false);
      navigate(`/projects/${n.entityId}`);
    } else if (n.kind === "Person" || n.kind === "Team") {
      setTrail([...trail, { type: n.kind === "Person" ? "user" : "team", id: n.entityId }]);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setTrail([]);
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>{trail.length === 0 && title ? title : "Access map"}</DialogTitle>
          <DialogDescription>
            Who → how they get access → what they can open. Click a person or team to see theirs, or a product to open
            it.
          </DialogDescription>
        </DialogHeader>
        {trail.length > 0 && (
          <Button variant="ghost" size="sm" className="w-fit" onClick={() => setTrail(trail.slice(0, -1))}>
            <ArrowLeft data-icon="inline-start" />
            Back
          </Button>
        )}
        <ErrorText error={map.error} />
        {map.isPending && open && <Loading />}
        {map.data && (
          <>
            {trail.length === 0 && preview && <PreviewSummary map={map.data} />}
            <AccessMapChart map={map.data} subjectId={`${current.type}:${current.id}`} onOpen={openNode} />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** One line on what the previewed change does: which products it opens up, and which it raises. */
function PreviewSummary({ map }: { map: AccessMapResponse }) {
  const added = map.nodes.filter((n) => n.kind === "Product" && n.change === "Added");
  const raised = map.nodes.filter((n) => n.kind === "Product" && n.change === "Raised");
  if (added.length === 0 && raised.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        This changes nothing they can reach: they already have this access.
      </p>
    );
  const names = (nodes: AccessMapNode[]) => nodes.map((n) => `${n.label} (${n.role})`).join(", ");
  return (
    <p className="text-sm">
      {added.length > 0 && (
        <span>
          <span className="font-medium text-emerald-700 dark:text-emerald-400">Opens</span> {names(added)}.{" "}
        </span>
      )}
      {raised.length > 0 && (
        <span>
          <span className="font-medium text-amber-700 dark:text-amber-400">Raises</span> {names(raised)}.
        </span>
      )}
    </p>
  );
}

/** The flow chart itself: boxes in columns, curved lines between them, with the role each route gives. */
export function AccessMapChart({
  map,
  subjectId,
  onOpen,
}: {
  map: AccessMapResponse;
  subjectId: string;
  onOpen: (node: AccessMapNode) => void;
}) {
  const layout: AccessMapLayout = layoutAccessMap(map);
  const products = map.nodes.filter((n) => n.kind === "Product").length;

  return (
    <div className="space-y-2">
      <div className="max-h-[60vh] overflow-auto rounded-md border bg-muted/30 p-4">
        {products === 0 && map.hiddenProducts === 0 && (
          <p className="mb-3 text-sm text-muted-foreground">No products yet.</p>
        )}
        <div className="relative" style={{ width: layout.width, height: layout.height }}>
          <svg
            className="absolute inset-0 overflow-visible"
            width={layout.width}
            height={layout.height}
            aria-hidden="true"
          >
            {layout.edges.map((e) => (
              <g key={`${e.from}>${e.to}`}>
                <path
                  d={e.path}
                  fill="none"
                  strokeWidth={e.change ? 2 : 1.5}
                  strokeDasharray={e.change ? "6 4" : undefined}
                  className={e.change ? "stroke-emerald-500" : "stroke-muted-foreground/50"}
                />
                {e.role && (
                  <text
                    x={e.labelX}
                    y={e.labelY - 4}
                    textAnchor="middle"
                    className="fill-muted-foreground text-[10px]"
                    paintOrder="stroke"
                    stroke="var(--background)"
                    strokeWidth={3}
                  >
                    {e.role}
                  </text>
                )}
              </g>
            ))}
          </svg>
          {layout.nodes.map((n) => {
            const Icon = KIND_ICON[n.kind];
            const clickable =
              n.id !== subjectId && n.entityId != null && n.kind !== "Direct" && n.kind !== "Organisation";
            const Box = clickable ? "button" : "div";
            return (
              <Box
                key={n.id}
                type={clickable ? "button" : undefined}
                onClick={clickable ? () => onOpen(n) : undefined}
                className={`absolute flex items-center gap-2 rounded-lg border bg-background px-2.5 text-left text-sm shadow-xs ${
                  n.change ? CHANGE_STYLE[n.change] : ""
                } ${n.id === subjectId ? "ring-2 ring-primary" : ""} ${clickable ? "hover:bg-muted" : ""}`}
                style={{ left: n.x, top: n.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
                title={n.detail ?? undefined}
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{n.label}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {n.kind === "Product" && n.change === "Raised" && n.previousRole
                      ? `${n.previousRole} → ${n.role}`
                      : n.kind === "Product" && n.change === "Added"
                        ? `New: ${n.role}`
                        : (n.detail ?? "")}
                  </span>
                </span>
                {n.kind === "Product" && !n.change && n.role && <Badge variant="secondary">{n.role}</Badge>}
              </Box>
            );
          })}
        </div>
      </div>
      {map.hiddenProducts > 0 && (
        <p className="text-xs text-muted-foreground">
          +{map.hiddenProducts} {map.hiddenProducts === 1 ? "product" : "products"} you can't see.
        </p>
      )}
    </div>
  );
}

/** A button that opens the access map for a person or team, optionally previewing a change. */
export function AccessMapButton({
  orgId,
  subject,
  preview,
  title,
  label,
  disabled,
}: {
  orgId: string;
  subject: MapSubject | null;
  preview?: MapPreview;
  title?: string;
  label: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" size="sm" disabled={disabled || !subject} onClick={() => setOpen(true)}>
        {label}
      </Button>
      {subject && (
        <AccessMapDialog
          orgId={orgId}
          subject={subject}
          preview={preview}
          title={title}
          open={open}
          onOpenChange={setOpen}
        />
      )}
    </>
  );
}
