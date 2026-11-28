import { initials, safeColor } from "@inklayer/overlay";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@inklayer/ui/components/alert-dialog";
import { Badge } from "@inklayer/ui/components/badge";
import { Button } from "@inklayer/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@inklayer/ui/components/dropdown-menu";
import { cn } from "@inklayer/ui/lib/utils";
import { BookOpen, Building2, Globe, History, Info, Link2, Lock, MoreHorizontal, PenLine, Trash2 } from "lucide-react";
import { type KeyboardEvent, useEffect, useState } from "react";
import { useMe } from "@/App";
import { ErrorText } from "@/components/Layout";
import { PublicBadge, useDocPublicLink } from "@/components/Shares";
import { timeAgo } from "@/lib/format";
import { personTitle } from "@/lib/people";
import { refreshAll } from "@/lib/query";
import { navigate } from "@/lib/router";
import type { DocSession, Peer, SessionStatus } from "../collab";
import { DocIcon } from "../docIcons";
import { type DocInfo, type DocTree, docsApi } from "../docsApi";
import { type Appearance, IconPicker } from "../IconPicker";
import { rewriteLinks } from "../links";
import { TagBar } from "../tags";
import { statusDotClass, statusLabel } from "./docViewText";
import { OrgShareDialog, useOrgShareOptions } from "./OrgShareDialog";
import { useSessionState } from "./useSessionState";

export type Mode = "edit" | "read";

export interface DocHeaderProps {
  orgId: string;
  info: DocInfo;
  tree: DocTree;
  session: DocSession;
  mode: Mode;
  setMode: (mode: Mode) => void;
  canEdit: boolean;
  onTag: (tag: string) => void;
  onHistory: () => void;
  onGuide: () => void;
  /** Scrolls to someone's pointer; left out when live cursors are off. */
  onFollow?: (peerId: string) => void;
}

/** The doc's folder, save status and tools, then its icon, title, tags and who edited it last. */
export function DocHeader(props: DocHeaderProps) {
  const { orgId, info, tree, session, canEdit } = props;
  const [error, setError] = useState<Error | null>(null);
  const state = useSessionState(session);

  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        {info.sharedFrom ? (
          <Badge
            variant="outline"
            title={`This doc belongs to ${info.sharedFrom.name}, which shares it with this organisation. It's the same doc there: edits show up on both sides.`}
          >
            <Building2 data-icon="inline-start" />
            Shared from {info.sharedFrom.name}
          </Badge>
        ) : (
          <span className="truncate">{info.folder ? info.folder.split("/").join(" / ") : "Docs"}</span>
        )}
        <div className="flex items-center gap-1">
          <SaveStatus status={state?.status ?? "connecting"} canEdit={canEdit} />
          <PeopleHere peers={state?.peers ?? []} onFollow={props.onFollow} />
          <DocTools {...props} onError={setError} />
        </div>
      </div>
      {/* Renaming and the icon belong to the doc's own organisation. */}
      <TitleRow info={info} canEdit={canEdit && !!info.canManage} onError={setError} />
      <TagBar orgId={orgId} tree={tree} session={session} fallback={info.tags} canEdit={canEdit} onTag={props.onTag} />
      <p className="mt-1 text-xs text-muted-foreground">
        {info.updatedBy ? (
          <>
            Edited by <span title={personTitle(info.updatedBy)}>{info.updatedBy.displayName}</span>{" "}
            {timeAgo(info.updatedAt)}
          </>
        ) : (
          `Created ${timeAgo(info.createdAt)}`
        )}
      </p>
      <ErrorText error={error} />
    </div>
  );
}

/** A coloured dot and "Live · saved automatically", "Offline · edits kept", etc. */
export function SaveStatus({ status, canEdit }: { status: SessionStatus; canEdit: boolean }) {
  const live = status === "live";
  return (
    <span
      className={cn("mr-2 inline-flex items-center gap-1.5 text-xs", live && "text-emerald-600 dark:text-emerald-400")}
    >
      <span className={cn("size-2 rounded-full", statusDotClass(status))} />
      {statusLabel(status, canEdit)}
    </span>
  );
}

/** Faces shown before the rest are counted as "+N". */
const MAX_FACES = 5;

/** The faces of others with the doc open; clicking one scrolls to their pointer. */
export function PeopleHere({ peers, onFollow }: { peers: Peer[]; onFollow?: (peerId: string) => void }) {
  if (peers.length === 0) return null;
  const shown = peers.slice(0, MAX_FACES);
  const rest = peers.slice(shown.length);
  const face =
    "-ml-1.5 grid size-6 place-items-center rounded-full border-2 border-background text-[10px] font-bold text-white";
  return (
    <span className="mr-2 flex pl-1.5">
      {shown.map((peer) =>
        onFollow ? (
          <button
            key={peer.id}
            type="button"
            className={cn(face, "cursor-pointer")}
            style={{ background: safeColor(peer.color) }}
            title={`${peer.name}: show their cursor`}
            aria-label={`${peer.name}: show their cursor`}
            onClick={() => onFollow(peer.id)}
          >
            {initials(peer.name)}
          </button>
        ) : (
          <span key={peer.id} className={face} style={{ background: safeColor(peer.color) }} title={peer.name}>
            {initials(peer.name)}
          </span>
        ),
      )}
      {rest.length > 0 && (
        <span className={cn(face, "bg-muted-foreground")} title={rest.map((p) => p.name).join(", ")}>
          +{rest.length}
        </span>
      )}
    </span>
  );
}

/**
 * Read/Edit and the cheat sheet, then a menu with History, sharing and Delete (sharing and deleting only from the doc's
 * own organisation), so the header stays short.
 */
function DocTools({
  orgId,
  info,
  mode,
  setMode,
  canEdit,
  onHistory,
  onGuide,
  onError,
}: DocHeaderProps & { onError: (e: Error | null) => void }) {
  const { me } = useMe();
  const [orgShareOpen, setOrgShareOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const orgShare = useOrgShareOptions(info);
  const publicLinks = me.features.sharing && !info.sharedFrom;
  const publicLink = useDocPublicLink(info.id, publicLinks);
  const live = publicLinks ? publicLink.live : undefined;
  const canPublish = publicLinks && !live && !!info.canManage;

  const remove = async () => {
    try {
      await docsApi.delete(info.id, info.version);
      navigate(`/orgs/${orgId}/docs`);
    } catch (e) {
      onError(e as Error);
    }
  };
  const editing = mode === "edit";
  return (
    <>
      {live && <PublicBadge share={live} />}
      {canEdit && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setMode(editing ? "read" : "edit")}
          title={editing ? "Reading view" : "Edit"}
        >
          {editing ? <BookOpen data-icon="inline-start" /> : <PenLine data-icon="inline-start" />}
          {editing ? "Read" : "Edit"}
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        title="Markdown cheat sheet"
        aria-label="Markdown cheat sheet"
        onClick={onGuide}
      >
        <Info />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon" className="size-8" title="More" aria-label="More" />}
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onClick={onHistory}>
            <History />
            History
          </DropdownMenuItem>
          {orgShare && (
            <DropdownMenuItem onClick={() => setOrgShareOpen(true)}>
              <Building2 />
              {orgShare.label}
            </DropdownMenuItem>
          )}
          {canPublish && (
            <DropdownMenuItem onClick={publicLink.makePublic}>
              <Globe />
              Make public
            </DropdownMenuItem>
          )}
          {live && (
            <DropdownMenuItem onClick={publicLink.copy}>
              <Link2 />
              Copy public link
            </DropdownMenuItem>
          )}
          {live?.canRevoke && (
            <DropdownMenuItem onClick={publicLink.makePrivate}>
              <Lock />
              Make private
            </DropdownMenuItem>
          )}
          {info.canManage && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => setDeleteOpen(true)}>
                <Trash2 />
                Delete doc
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <ErrorText error={publicLinks ? publicLink.error : null} />
      <OrgShareDialog info={info} open={orgShareOpen} onOpenChange={setOrgShareOpen} />
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{info.title}"?</AlertDialogTitle>
            <AlertDialogDescription>
              Anyone with it open loses it, and links to it show as missing until it's back. You can restore it, with
              its text and history, from Deleted docs at the bottom of the sidebar.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void remove()}>
              Delete doc
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function appearanceOf(info: DocInfo): Appearance {
  return { icon: info.icon ?? null, color: info.color ?? null };
}

/** The doc's icon (click to change it) and its title (edit in place; Enter saves, Escape puts it back). */
export function TitleRow({
  info,
  canEdit,
  onError,
}: {
  info: DocInfo;
  canEdit: boolean;
  onError: (e: Error | null) => void;
}) {
  const [title, setTitle] = useState(info.title);
  useEffect(() => setTitle(info.title), [info.title]);

  // The icon shows the new choice at once; saving happens behind it, and the sidebar and graph pick it up after.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [appearance, setAppearance] = useState<Appearance>(() => appearanceOf(info));
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the saved icon or colour changes
  useEffect(() => setAppearance(appearanceOf(info)), [info.icon, info.color]);

  const changeAppearance = async (next: Appearance) => {
    setAppearance(next);
    try {
      await docsApi.setAppearance(info.id, next);
      onError(null);
      await refreshAll();
    } catch (e) {
      onError(e as Error);
      setAppearance(appearanceOf(info));
    }
  };

  const rename = async () => {
    const next = title.trim();
    if (!next || next === info.title) {
      setTitle(info.title);
      return;
    }
    try {
      const result = await docsApi.update(info.id, { version: info.version, title: next });
      await rewriteLinks(result.relinkDocs, [{ from: info, to: { folder: info.folder, title: result.doc.title } }]);
      onError(null);
      await refreshAll();
    } catch (e) {
      onError(e as Error);
      setTitle(info.title);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") e.currentTarget.blur();
    if (e.key === "Escape") {
      setTitle(info.title);
      e.currentTarget.blur();
    }
  };

  const icon = <DocIcon icon={appearance.icon} color={appearance.color} />;
  return (
    <>
      <div className="mt-2 flex items-center gap-2">
        {canEdit ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-10 shrink-0 [&_svg]:size-7"
            title="Change icon and colour"
            aria-label="Change icon and colour"
            onClick={() => setPickerOpen(true)}
          >
            {icon}
          </Button>
        ) : (
          <span className="flex size-10 shrink-0 items-center justify-center [&_svg]:size-7">{icon}</span>
        )}
        <input
          className="doc-title-input"
          value={title}
          disabled={!canEdit}
          aria-label="Title"
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => void rename()}
          onKeyDown={onKeyDown}
        />
      </div>
      <IconPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        value={appearance}
        onChange={(next) => void changeAppearance(next)}
      />
    </>
  );
}
