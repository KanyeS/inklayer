import { Button } from "@inklayer/ui/components/button";
import { cn } from "@inklayer/ui/lib/utils";
import { BookOpen, History, Info, PenLine, Trash2 } from "lucide-react";
import { type KeyboardEvent, useEffect, useState } from "react";
import { useMe } from "@/App";
import { ConfirmButton } from "@/components/ConfirmButton";
import { ErrorText } from "@/components/Layout";
import { DocShareButton } from "@/components/Shares";
import { timeAgo } from "@/lib/format";
import { personTitle } from "@/lib/people";
import { refreshAll } from "@/lib/query";
import { navigate } from "@/lib/router";
import type { DocSession, SessionStatus } from "../collab";
import { DocIcon } from "../docIcons";
import { type DocInfo, type DocTree, docsApi } from "../docsApi";
import { type Appearance, IconPicker } from "../IconPicker";
import { rewriteLinks } from "../links";
import { TagBar } from "../tags";
import { statusDotClass, statusLabel } from "./docViewText";
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
}

/** The doc's folder, save status and tools, then its icon, title, tags and who edited it last. */
export function DocHeader(props: DocHeaderProps) {
  const { orgId, info, tree, session, canEdit } = props;
  const [error, setError] = useState<Error | null>(null);
  const state = useSessionState(session);

  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <span className="truncate">{info.folder ? info.folder.split("/").join(" / ") : "Docs"}</span>
        <div className="flex items-center gap-1">
          <SaveStatus status={state?.status ?? "connecting"} canEdit={canEdit} />
          <DocTools {...props} onError={setError} />
        </div>
      </div>
      <TitleRow info={info} canEdit={canEdit} onError={setError} />
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
function SaveStatus({ status, canEdit }: { status: SessionStatus; canEdit: boolean }) {
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

/** Read/Edit, the cheat sheet, History, Share and Delete. */
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
      <Button variant="ghost" size="sm" onClick={onHistory}>
        <History data-icon="inline-start" />
        History
      </Button>
      {me.features.sharing && <DocShareButton docId={info.id} canEdit={canEdit} />}
      {canEdit && (
        <ConfirmButton
          title={`Delete "${info.title}"?`}
          description="Anyone with it open loses it, and links to it show as missing until it's back. You can restore it, with its text and history, from Deleted docs at the bottom of the sidebar."
          confirmLabel="Delete doc"
          onConfirm={() => void remove()}
        >
          <Trash2 />
        </ConfirmButton>
      )}
    </>
  );
}

function appearanceOf(info: DocInfo): Appearance {
  return { icon: info.icon ?? null, color: info.color ?? null };
}

/** The doc's icon (click to change it) and its title (edit in place; Enter saves, Escape puts it back). */
function TitleRow({ info, canEdit, onError }: { info: DocInfo; canEdit: boolean; onError: (e: Error | null) => void }) {
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
