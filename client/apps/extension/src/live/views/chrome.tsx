/** @jsxImportSource preact */
import { copyText } from "@inklayer/overlay";
import type { ComponentChild } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { badgeCount, plural, shortDate } from "../format";
import { icon } from "../icons";

/**
 * The panel's frame: the collapsed launcher button, the header with its tabs and icons, the corner pin, and the notices
 * under the header. Each is rendered from plain values and callbacks; the session decides what they show.
 */

/** Matches elements a header drag or double-click mustn't start from (they have their own pointer behaviour). */
export const FORM_CONTROLS = "select, input, textarea";
const CONTROLS = "button, select, input, textarea, a, label";

const COPIED_RESET_MS = 1500;

export interface LauncherOptions {
  openCount: number;
  unread: number;
  pinned: boolean;
  onOpen(): void;
  onDragStart(e: PointerEvent): void;
}

/** The collapsed panel: "Inklayer", the open-comment count, and unread notifications. */
export function launcher(o: LauncherOptions): ComponentChild {
  return (
    <button
      type="button"
      className={o.pinned ? "launcher" : "launcher movable"}
      title={o.pinned ? "Inklayer comments on this page" : "Inklayer comments on this page (drag to move)"}
      onClick={o.onOpen}
      onPointerDown={o.onDragStart}
    >
      Inklayer
      <span
        className={o.openCount ? "count" : "count zero"}
        title={`${plural(o.openCount, "open comment")} on this page`}
      >
        {o.openCount}
      </span>
      {o.unread > 0 && (
        <span className="bell-count" title={plural(o.unread, "unread notification")}>
          {icon("bell")}
          {Math.min(o.unread, 99)}
        </span>
      )}
    </button>
  );
}

interface IconButtonProps {
  name: Parameters<typeof icon>[0];
  title: string;
  onClick: () => void;
  on?: boolean;
  disabled?: boolean;
  extraClass?: string;
  children?: ComponentChild;
}

/** One of the header's toggle icons. */
function IconButton({ name, title, onClick, on, disabled = false, extraClass, children }: IconButtonProps) {
  const classes = ["icon", "svg", extraClass, on ? "on" : ""].filter(Boolean).join(" ");
  return (
    <button type="button" className={classes} title={title} onClick={onClick} disabled={disabled} aria-pressed={on}>
      {icon(name)}
      {children}
    </button>
  );
}

export interface HeaderOptions {
  view: "comments" | "activity" | "inbox";
  busy: boolean;
  unread: number;
  /** The project a share link would be for; null hides the share button. */
  shareProject: string | null;
  bubblesOpen: boolean;
  marksVisible: boolean;
  pinned: boolean;
  /** A drag just ended, so the click that follows it shouldn't press anything. */
  justDragged(): boolean;
  onView(view: "comments" | "activity" | "inbox"): void;
  onShare(): void;
  onBubblesOpen(open: boolean): void;
  onMarksVisible(visible: boolean): void;
  onMinimise(): void;
  onDragStart(e: PointerEvent): void;
  onResetPosition(): void;
}

/** Tabs on the left; share, bubbles, marks, notifications and minimise on the right. Drags the panel when unpinned. */
export function header(o: HeaderOptions): ComponentChild {
  const tab = (view: "comments" | "activity", label: string) => (
    <button type="button" className={o.view === view ? "tab active" : "tab"} onClick={() => o.onView(view)}>
      {label}
    </button>
  );
  const inbox = o.view === "inbox";
  // A drag that ends over a tab or icon doesn't also press it.
  const swallowDragClick = (e: MouseEvent) => {
    if (!o.justDragged()) return;
    e.stopPropagation();
    e.preventDefault();
  };
  const resetOnDoubleClick = (e: MouseEvent) => {
    if (!(e.target as Element).closest(CONTROLS)) o.onResetPosition();
  };
  return (
    <div
      className={o.pinned ? "header" : "header movable"}
      onPointerDown={o.onDragStart}
      onClickCapture={swallowDragClick}
      onDblClick={o.pinned ? undefined : resetOnDoubleClick}
    >
      {!o.pinned && (
        <span className="grip" title="Drag to move · double-click to put back in the corner">
          {icon("grip")}
        </span>
      )}
      <div className="tabs">
        {tab("comments", "Comments")}
        {tab("activity", "Activity")}
      </div>
      <div className="actions">
        {o.shareProject !== null && (
          <IconButton
            name="link"
            title={`Share this page: copy a read-only link to its open comments in ${o.shareProject}, for people without an account (works for 30 days)`}
            onClick={o.onShare}
            disabled={o.busy}
          />
        )}
        <IconButton
          name="comments"
          on={o.bubblesOpen}
          title={
            o.bubblesOpen
              ? "Comments are open next to their marks. Click to show them only on hover."
              : "Open every comment next to its mark (otherwise they show on hover)"
          }
          onClick={() => o.onBubblesOpen(!o.bubblesOpen)}
        />
        {/* The marks toggle is plain (not pressed/unpressed): the icon itself says which state it's in. */}
        <button
          type="button"
          className="icon svg"
          title={o.marksVisible ? "Hide marks on the page" : "Show marks on the page"}
          onClick={() => o.onMarksVisible(!o.marksVisible)}
        >
          {icon(o.marksVisible ? "eye" : "eyeOff")}
        </button>
        <IconButton
          name="bell"
          extraClass="bell"
          on={inbox}
          title={o.unread ? `Notifications: ${o.unread} unread` : "Notifications"}
          onClick={() => o.onView(inbox ? "comments" : "inbox")}
        >
          {o.unread > 0 && <span className="badge">{badgeCount(o.unread)}</span>}
        </IconButton>
        <button type="button" className="icon svg" title="Minimise" onClick={o.onMinimise}>
          {icon("minimise")}
        </button>
      </div>
    </div>
  );
}

/** The pin on the panel's top-right corner, like a pushpin: pinned keeps the panel in place; unpinned, the header drags it. */
export function cornerPin(pinned: boolean, onToggle: () => void): ComponentChild {
  return (
    <button
      type="button"
      className={pinned ? "corner-pin on" : "corner-pin"}
      aria-pressed={pinned}
      title={
        pinned
          ? "Pinned in place. Click to unpin, then drag the header to move the panel."
          : "Unpinned: drag the header to move the panel (double-click it to put it back in the corner). Click to pin it here."
      }
      onClick={onToggle}
    >
      {icon(pinned ? "pin" : "pinOff")}
    </button>
  );
}

/** The window's size was matched to a commenter's. */
export type SizeMatch = { width: number; height: number | null } | "unknown";

/** "Showing the page at their size", with "Back to my size". */
export function sizeBar(match: SizeMatch, onRestore: () => void): ComponentChild {
  const text =
    match === "unknown"
      ? "This window was resized to a commenter's size."
      : `Showing the page at their size: ${match.width}${match.height ? `×${match.height}` : "px wide"}.`;
  return (
    <div className="row size-bar">
      <span>{text}</span>
      <button type="button" className="link" onClick={onRestore}>
        Back to my size
      </button>
    </div>
  );
}

/** The last "Share this page" result. */
export interface SharedLink {
  url: string;
  existing: boolean;
  expiresAt: string | null;
  projectName: string;
  copied: boolean;
}

interface CopyButtonProps {
  label: string;
  text: string;
  className?: string;
  title?: string;
  /** Start out saying "Copied" (it was copied as the button appeared). */
  copied?: boolean;
}

/** A button that copies text and briefly says whether it worked. */
function CopyButton({ label, text, className = "link", title, copied = false }: CopyButtonProps) {
  const [shown, setShown] = useState(copied ? "Copied" : label);
  const reset = useRef(0);
  useEffect(() => () => window.clearTimeout(reset.current), []);
  const copy = (e: Event) => {
    e.stopPropagation();
    void copyText(text).then((ok) => {
      setShown(ok ? "Copied" : "Couldn't copy");
      window.clearTimeout(reset.current);
      reset.current = window.setTimeout(() => setShown(label), COPIED_RESET_MS);
    });
  };
  return (
    <button type="button" className={className} title={title} onClick={copy}>
      {shown}
    </button>
  );
}

export function copyButton(
  label: string,
  text: string,
  options: Omit<CopyButtonProps, "label" | "text"> = {},
): ComponentChild {
  return <CopyButton label={label} text={text} {...options} />;
}

/** Before a share link is made: what it gives away, to whom and for how long, with Create link and Cancel. */
export function shareConfirmBox(
  projectName: string,
  busy: boolean,
  onConfirm: () => void,
  onCancel: () => void,
): ComponentChild {
  return (
    <div className="shared share-confirm" role="alertdialog" aria-labelledby="share-confirm-title">
      <strong id="share-confirm-title">Make this page's comments public?</strong>
      <p className="hint">
        Anyone with the link can read this page's open comments in {projectName}, with no account needed: what they say,
        their replies, their screenshots and who wrote them (shown names only). It's copied for you to send.
      </p>
      <p className="hint">
        The link works for 30 days, or until someone turns it off from the project's Sharing tab. If this page already
        has one, you get the same link.
      </p>
      <div className="row actions-row">
        <button type="button" className="link" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="primary" disabled={busy} onClick={onConfirm}>
          Create link
        </button>
      </div>
    </div>
  );
}

/** The share link, with what it shows and until when; stays until closed. */
export function sharedBox(shared: SharedLink, onClose: () => void): ComponentChild {
  const until = shared.expiresAt ? `until ${shortDate(shared.expiresAt)}` : "with no end date";
  const already = shared.existing ? "It already existed, so it's the same link as before. " : "";
  const copied = shared.copied ? "Copied. " : "";
  return (
    <div className="shared">
      <div className="row">
        <strong>{shared.existing ? "This page's share link" : "Share link created"}</strong>
        <button type="button" className="icon close" title="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="row link-row">
        <a className="share-url" href={shared.url} target="_blank" rel="noopener noreferrer" title={shared.url}>
          {shared.url}
        </a>
        {copyButton("Copy", shared.url, { copied: shared.copied })}
      </div>
      <p className="hint">
        {already}
        {copied}Anyone with it can read this page's open comments in {shared.projectName}, {until}. Turn it off from the
        project's Sharing tab.
      </p>
    </div>
  );
}
