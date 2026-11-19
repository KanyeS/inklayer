import { copyText, h } from "@inklayer/overlay";
import { badgeCount, plural, shortDate } from "../format";
import { icon } from "../icons";

/**
 * The panel's frame: the collapsed launcher button, the header with its tabs and icons, the corner pin, and the notices
 * under the header. Each is built from plain values and callbacks; the session decides what they show.
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
export function launcher(o: LauncherOptions): HTMLButtonElement {
  const button = h(
    "button",
    {
      className: o.pinned ? "launcher" : "launcher movable",
      title: o.pinned ? "Inklayer comments on this page" : "Inklayer comments on this page (drag to move)",
      onclick: o.onOpen,
    },
    "Inklayer",
    h("span", {
      className: o.openCount ? "count" : "count zero",
      textContent: String(o.openCount),
      title: `${plural(o.openCount, "open comment")} on this page`,
    }),
    o.unread > 0 &&
      h(
        "span",
        { className: "bell-count", title: `${plural(o.unread, "unread notification")}` },
        icon("bell"),
        String(Math.min(o.unread, 99)),
      ),
  );
  button.addEventListener("pointerdown", o.onDragStart);
  return button;
}

/** One of the header's toggle icons. */
function iconButton(
  name: Parameters<typeof icon>[0],
  props: { title: string; onclick: () => void; on?: boolean; disabled?: boolean; extraClass?: string },
  ...extra: (Node | false)[]
): HTMLButtonElement {
  const classes = ["icon", "svg", props.extraClass, props.on ? "on" : ""].filter(Boolean).join(" ");
  return h(
    "button",
    {
      className: classes,
      title: props.title,
      onclick: props.onclick,
      disabled: props.disabled ?? false,
      ...(props.on === undefined ? {} : { ariaPressed: String(props.on) }),
    },
    icon(name),
    ...extra,
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
export function header(o: HeaderOptions): HTMLElement {
  const tab = (view: "comments" | "activity", label: string) =>
    h("button", {
      className: o.view === view ? "tab active" : "tab",
      textContent: label,
      onclick: () => o.onView(view),
    });
  const inbox = o.view === "inbox";
  const actions = h(
    "div",
    { className: "actions" },
    o.shareProject !== null &&
      iconButton("link", {
        title: `Share this page: copy a read-only link to its open comments in ${o.shareProject}, for people without an account (works for 30 days)`,
        onclick: o.onShare,
        disabled: o.busy,
      }),
    iconButton("comments", {
      on: o.bubblesOpen,
      title: o.bubblesOpen
        ? "Comments are open next to their marks. Click to show them only on hover."
        : "Open every comment next to its mark (otherwise they show on hover)",
      onclick: () => o.onBubblesOpen(!o.bubblesOpen),
    }),
    // The marks toggle is plain (not pressed/unpressed): the icon itself says which state it's in.
    h(
      "button",
      {
        className: "icon svg",
        title: o.marksVisible ? "Hide marks on the page" : "Show marks on the page",
        onclick: () => o.onMarksVisible(!o.marksVisible),
      },
      icon(o.marksVisible ? "eye" : "eyeOff"),
    ),
    iconButton(
      "bell",
      {
        extraClass: "bell",
        on: inbox,
        title: o.unread ? `Notifications: ${o.unread} unread` : "Notifications",
        onclick: () => o.onView(inbox ? "comments" : "inbox"),
      },
      o.unread > 0 && h("span", { className: "badge", textContent: badgeCount(o.unread) }),
    ),
    h("button", { className: "icon svg", title: "Minimise", onclick: o.onMinimise }, icon("minimise")),
  );
  const bar = h(
    "div",
    { className: "header" },
    h("div", { className: "tabs" }, tab("comments", "Comments"), tab("activity", "Activity")),
    actions,
  );
  bar.addEventListener("pointerdown", o.onDragStart);
  // A drag that ends over a tab or icon doesn't also press it.
  bar.addEventListener(
    "click",
    (e) => {
      if (!o.justDragged()) return;
      e.stopPropagation();
      e.preventDefault();
    },
    true,
  );
  if (!o.pinned) {
    bar.classList.add("movable");
    bar.prepend(
      h("span", { className: "grip", title: "Drag to move · double-click to put back in the corner" }, icon("grip")),
    );
    bar.addEventListener("dblclick", (e) => {
      if (!(e.target as Element).closest(CONTROLS)) o.onResetPosition();
    });
  }
  return bar;
}

/** The pin on the panel's top-right corner, like a pushpin: pinned keeps the panel in place; unpinned, the header drags it. */
export function cornerPin(pinned: boolean, onToggle: () => void): HTMLButtonElement {
  return h(
    "button",
    {
      className: pinned ? "corner-pin on" : "corner-pin",
      ariaPressed: String(pinned),
      title: pinned
        ? "Pinned in place. Click to unpin, then drag the header to move the panel."
        : "Unpinned: drag the header to move the panel (double-click it to put it back in the corner). Click to pin it here.",
      onclick: onToggle,
    },
    icon(pinned ? "pin" : "pinOff"),
  );
}

/** The window's size was matched to a commenter's. */
export type SizeMatch = { width: number; height: number | null } | "unknown";

/** "Showing the page at their size", with "Back to my size". */
export function sizeBar(match: SizeMatch, onRestore: () => void): HTMLElement {
  const text =
    match === "unknown"
      ? "This window was resized to a commenter's size."
      : `Showing the page at their size: ${match.width}${match.height ? `×${match.height}` : "px wide"}.`;
  return h(
    "div",
    { className: "row size-bar" },
    h("span", { textContent: text }),
    h("button", { className: "link", textContent: "Back to my size", onclick: onRestore }),
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

/** A button that copies text and briefly says whether it worked. */
export function copyButton(label: string, text: string, className = "link"): HTMLButtonElement {
  const button = h("button", {
    className,
    textContent: label,
    onclick: (e: Event) => {
      e.stopPropagation();
      void copyText(text).then((ok) => {
        button.textContent = ok ? "Copied" : "Couldn't copy";
        window.setTimeout(() => {
          button.textContent = label;
        }, COPIED_RESET_MS);
      });
    },
  });
  return button;
}

/** The share link, with what it shows and until when; stays until closed. */
export function sharedBox(shared: SharedLink, onClose: () => void): HTMLElement {
  const until = shared.expiresAt ? `until ${shortDate(shared.expiresAt)}` : "with no end date";
  const copy = copyButton("Copy", shared.url);
  if (shared.copied) copy.textContent = "Copied";
  const already = shared.existing ? "It already existed, so it's the same link as before. " : "";
  const copied = shared.copied ? "Copied. " : "";
  return h(
    "div",
    { className: "shared" },
    h(
      "div",
      { className: "row" },
      h("strong", { textContent: shared.existing ? "This page's share link" : "Share link created" }),
      h("button", { className: "icon close", title: "Close", textContent: "×", onclick: onClose }),
    ),
    h(
      "div",
      { className: "row link-row" },
      h("a", {
        className: "share-url",
        href: shared.url,
        target: "_blank",
        rel: "noopener noreferrer",
        textContent: shared.url,
        title: shared.url,
      }),
      copy,
    ),
    h("p", {
      className: "hint",
      textContent: `${already}${copied}Anyone with it can read this page's open comments in ${shared.projectName}, ${until}. Turn it off from the project's Sharing tab.`,
    }),
  );
}
