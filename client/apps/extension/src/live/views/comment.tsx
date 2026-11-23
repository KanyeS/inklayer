/** @jsxImportSource preact */
import { stopPropagation } from "@inklayer/overlay";
import { type ComponentChild, Fragment } from "preact";
import { personTitle } from "../../lib/people";
import { docUrl, type PageAnnotation, type PanelContext } from "../context";
import { addressOf, plural, timeAgo } from "../format";
import { icon } from "../icons";
import type { ImproveControls } from "../improve";
import { SuggestBox, type TextDraft } from "../suggestions";
import { copyButton } from "./chrome";
import type { CommentParts } from "./comment-parts";
import { improveArea, improveButton, improveNote } from "./improve";

/** A comment as it's shown: its entry in the panel's list, and its bubble next to the mark on the page. */

export interface CommentActions {
  /** Resolve or reopen. */
  setResolved(resolved: boolean): void;
  remove(): void;
  startEdit(): void;
  saveEdit(draft: TextDraft): void;
  cancelEdit(): void;
}

export interface ListEntryOptions {
  label: number;
  selected: boolean;
  /** The element it was on has changed; it's shown where it originally was. */
  orphaned: boolean;
  /** The project's name, when the page has comments from more than one. */
  projectName: string | null;
  /** On an address with a query or #hash: say whether each comment is for every version of the page or just this one. */
  showAddress: boolean;
  canComment: boolean;
  /** The text being edited (kept by the session), while this comment is being edited. */
  editing: {
    draft: TextDraft;
    onChange(draft: TextDraft): void;
    organizationId(): string | null;
    /** The Improve button (the local Claude helper); null when it's off. */
    improve?: ImproveControls | null;
  } | null;
  onSelect(): void;
  actions: CommentActions;
}

function author(a: PageAnnotation): ComponentChild {
  return (
    <>
      <strong title={personTitle(a.author)}>{a.author.displayName || "Someone"}</strong>
      {a.via && (
        <span className="via" title={`${a.via} left this for ${a.author.displayName || "them"}`}>
          via {a.via}
        </span>
      )}
    </>
  );
}

interface LinkButtonProps {
  label: string;
  run: () => void;
  className?: string;
  disabled?: boolean;
}

/** A button that does something to the comment without also selecting it. */
function LinkButton({ label, run, className = "link", disabled = false }: LinkButtonProps) {
  const click = (e: Event) => {
    e.stopPropagation();
    run();
  };
  return (
    <button type="button" className={className} disabled={disabled} onClick={click}>
      {label}
    </button>
  );
}

/** A comment's entry in the panel's list. Selected entries show the comment's details, thread and reply box. */
export function listEntry(
  ctx: PanelContext,
  parts: CommentParts,
  a: PageAnnotation,
  o: ListEntryOptions,
): ComponentChild {
  const resolved = a.status === "Resolved";
  const className = ["item", resolved ? "resolved" : "", o.selected ? "selected" : ""].join(" ");
  const replies = parts.threadLength(a);
  return (
    // Keyed by comment, so each keeps its own state (a reply being typed) when the list changes.
    <li key={a.id} className={className} data-id={a.id} onClick={o.onSelect}>
      <div className="meta">
        <span className="badge" style={{ background: a.color }}>
          {o.label}
        </span>
        {author(a)}
        <span className="muted">{timeAgo(a.createdAt)}</span>
        {o.projectName !== null && <span className="muted">· {o.projectName}</span>}
        {o.orphaned && (
          <span className="warn" title="The element this was attached to has changed; shown where it originally was.">
            moved
          </span>
        )}
      </div>
      {o.showAddress && (
        <span className="address" title={a.pageUrl ?? ""}>
          {addressOf(a.pageUrl)}
        </span>
      )}
      {o.editing ? (
        <>
          {improveArea(
            <SuggestBox
              draft={o.editing.draft}
              onChange={o.editing.onChange}
              organizationId={o.editing.organizationId}
              docsOn={ctx.init.features.docs}
              rows={3}
              autoFocus
              onClick={stopPropagation}
            />,
            o.editing.improve,
          )}
          <div className="row">
            <LinkButton
              label="Save"
              className="primary"
              disabled={ctx.busy || o.editing.improve?.busy === true}
              run={() => o.editing && o.actions.saveEdit(o.editing.draft)}
            />
            <LinkButton label="Cancel" className="" run={o.actions.cancelEdit} />
            {o.editing.improve && improveButton(o.editing.improve)}
          </div>
          {o.editing.improve && improveNote(o.editing.improve)}
        </>
      ) : (
        <>
          {a.body && parts.body(a)}
          {o.selected && (
            <>
              {parts.size(a)}
              {parts.screenshot(a)}
              {parts.details(a)}
              {parts.issues(a)}
            </>
          )}
          {ctx.init.features.docs && Boolean(a.mentionedIn?.length) && mentionedIn(ctx, a)}
          {o.selected && replies > 0 && parts.replies(a)}
          {o.selected && o.canComment && parts.replyBox(a, "panel")}
          {!o.selected && replies > 0 && <p className="muted replies-count">{plural(replies, "reply", "replies")}</p>}
          {entryActions(ctx, a, o)}
        </>
      )}
    </li>
  );
}

/** "Mentioned in Doc A, Doc B": the docs that link this comment. */
function mentionedIn(ctx: PanelContext, a: PageAnnotation): ComponentChild {
  return (
    <p className="muted mentions">
      Mentioned in{" "}
      {(a.mentionedIn ?? []).map((d, i) => (
        <Fragment key={d.docId}>
          {i > 0 && ", "}
          <a
            href={docUrl(ctx.init.serverUrl, a.organizationId, d.docId)}
            target="_blank"
            rel="noopener"
            onClick={stopPropagation}
          >
            {d.title}
          </a>
        </Fragment>
      ))}
    </p>
  );
}

/** Resolve/Reopen, Edit, Copy link and Delete, as the user's rights allow. */
function entryActions(ctx: PanelContext, a: PageAnnotation, o: ListEntryOptions): ComponentChild {
  const resolved = a.status === "Resolved";
  return (
    <div className="row actions">
      {o.canComment && (
        <LinkButton
          label={resolved ? "Reopen" : "Resolve"}
          disabled={ctx.busy}
          run={() => o.actions.setResolved(!resolved)}
        />
      )}
      {a.canEdit && <LinkButton label="Edit" run={o.actions.startEdit} />}
      {/* To paste into a doc, which links the comment there. */}
      {copyButton("Copy link", `${ctx.init.serverUrl}/comments/${a.id}`, {
        title: "Copy a link to this comment, to paste into a doc",
      })}
      {a.canDelete && (
        <LinkButton
          label="Delete"
          className="link danger"
          disabled={ctx.busy}
          run={() => window.confirm("Delete this comment?") && o.actions.remove()}
        />
      )}
    </div>
  );
}

export interface BubbleOptions {
  pinned: boolean;
  canComment: boolean;
  onTogglePin(): void;
  onShowInList(): void;
  actions: Pick<CommentActions, "setResolved">;
}

/** The content of a comment's bubble next to its mark: the comment, its details and thread, and a reply box. */
export function bubbleContent(
  ctx: PanelContext,
  parts: CommentParts,
  a: PageAnnotation,
  o: BubbleOptions,
): ComponentChild {
  const resolved = a.status === "Resolved";
  return (
    <>
      <div className="bubble-head">
        <span className="dot" style={{ background: a.color }} />
        {author(a)}
        <span className="muted">{timeAgo(a.createdAt)}</span>
        {resolved && <span className="muted">· resolved</span>}
        <span className="grow" />
        <button
          type="button"
          className={o.pinned ? "pin-toggle on" : "pin-toggle"}
          title={o.pinned ? "Unpin: show only on hover" : "Pin: keep this open"}
          onClick={o.onTogglePin}
        >
          {icon("pin")}
        </button>
      </div>
      {a.body && parts.body(a)}
      {parts.size(a)}
      {parts.screenshot(a)}
      {parts.details(a)}
      {parts.issues(a)}
      {parts.threadLength(a) > 0 && parts.replies(a)}
      {o.canComment && (
        <>
          {parts.replyBox(a, "bubble")}
          <div className="row">
            <button type="button" className="link" disabled={ctx.busy} onClick={() => o.actions.setResolved(!resolved)}>
              {resolved ? "Reopen" : "Resolve"}
            </button>
            <button type="button" className="link" onClick={o.onShowInList}>
              Show in list
            </button>
          </div>
        </>
      )}
    </>
  );
}
