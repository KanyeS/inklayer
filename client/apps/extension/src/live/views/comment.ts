import { h, stopPropagation } from "@inklayer/overlay";
import { personTitle } from "../../lib/people";
import { docUrl, type PageAnnotation, type PanelContext } from "../context";
import { addressOf, plural, timeAgo } from "../format";
import { icon } from "../icons";
import { copyButton } from "./chrome";
import type { CommentParts } from "./comment-parts";

/** A comment as it's shown: its entry in the panel's list, and its bubble next to the mark on the page. */

export interface CommentActions {
  /** Resolve or reopen. */
  setResolved(resolved: boolean): void;
  remove(): void;
  startEdit(): void;
  saveEdit(input: HTMLTextAreaElement): void;
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
  /** The edit box, wrapped with its suggestions, while this comment is being edited. */
  editing: { wrapper: HTMLElement; input: HTMLTextAreaElement } | null;
  onSelect(): void;
  actions: CommentActions;
}

function author(a: PageAnnotation): HTMLElement {
  return h("strong", { textContent: a.author.displayName || "Someone", title: personTitle(a.author) });
}

/** A comment's entry in the panel's list. Selected entries show the comment's details, thread and reply box. */
export function listEntry(
  ctx: PanelContext,
  parts: CommentParts,
  a: PageAnnotation,
  o: ListEntryOptions,
): HTMLLIElement {
  const resolved = a.status === "Resolved";
  const meta = h(
    "div",
    { className: "meta" },
    h("span", { className: "badge", textContent: String(o.label), style: { background: a.color } }),
    author(a),
    h("span", { className: "muted", textContent: timeAgo(a.createdAt) }),
    o.projectName !== null && h("span", { className: "muted", textContent: `· ${o.projectName}` }),
    o.orphaned &&
      h("span", {
        className: "warn",
        textContent: "moved",
        title: "The element this was attached to has changed; shown where it originally was.",
      }),
  );
  const className = ["item", resolved ? "resolved" : "", o.selected ? "selected" : ""].join(" ");
  const item = h("li", { className, onclick: o.onSelect }, meta);
  item.dataset.id = a.id;
  if (o.showAddress)
    item.append(h("span", { className: "address", textContent: addressOf(a.pageUrl), title: a.pageUrl ?? "" }));

  if (o.editing) {
    item.append(o.editing.wrapper, editButtons(ctx, o.editing.input, o.actions));
    return item;
  }

  if (a.body) item.append(parts.body(a));
  if (o.selected) item.append(parts.size(a), parts.screenshot(a), parts.details(a), parts.issues(a));
  if (ctx.init.features.docs && a.mentionedIn?.length) item.append(mentionedIn(ctx, a));
  if (o.selected) {
    if (a.replies?.length) item.append(parts.replies(a));
    if (o.canComment) item.append(parts.replyBox(a, "panel"));
  } else if (a.replies?.length) {
    item.append(
      h("p", { className: "muted replies-count", textContent: plural(a.replies.length, "reply", "replies") }),
    );
  }
  const actions = entryActions(ctx, a, o);
  if (actions.childElementCount) item.append(actions);
  return item;
}

function editButtons(ctx: PanelContext, input: HTMLTextAreaElement, actions: CommentActions): HTMLElement {
  return h(
    "div",
    { className: "row" },
    h("button", {
      className: "primary",
      textContent: "Save",
      disabled: ctx.busy,
      onclick: (e: Event) => {
        e.stopPropagation();
        actions.saveEdit(input);
      },
    }),
    h("button", {
      textContent: "Cancel",
      onclick: (e: Event) => {
        e.stopPropagation();
        actions.cancelEdit();
      },
    }),
  );
}

/** "Mentioned in Doc A, Doc B": the docs that link this comment. */
function mentionedIn(ctx: PanelContext, a: PageAnnotation): HTMLElement {
  const line = h("p", { className: "muted mentions" }, "Mentioned in ");
  (a.mentionedIn ?? []).forEach((d, i) => {
    if (i > 0) line.append(", ");
    line.append(
      h("a", {
        href: docUrl(ctx.init.serverUrl, a.organizationId, d.docId),
        target: "_blank",
        rel: "noopener",
        textContent: d.title,
        onclick: stopPropagation,
      }),
    );
  });
  return line;
}

/** Resolve/Reopen, Edit, Copy link and Delete, as the user's rights allow. */
function entryActions(ctx: PanelContext, a: PageAnnotation, o: ListEntryOptions): HTMLElement {
  const resolved = a.status === "Resolved";
  const actions = h("div", { className: "row actions" });
  const link = (label: string, run: () => void, extraClass = "", disabled = ctx.busy) =>
    h("button", {
      className: `link${extraClass}`,
      textContent: label,
      disabled,
      onclick: (e: Event) => {
        e.stopPropagation();
        run();
      },
    });
  if (o.canComment) actions.append(link(resolved ? "Reopen" : "Resolve", () => o.actions.setResolved(!resolved)));
  if (a.canEdit) actions.append(link("Edit", o.actions.startEdit, "", false));
  // To paste into a doc, which links the comment there.
  const copy = copyButton("Copy link", `${ctx.init.serverUrl}/comments/${a.id}`);
  copy.title = "Copy a link to this comment, to paste into a doc";
  actions.append(copy);
  if (a.canDelete) {
    actions.append(link("Delete", () => window.confirm("Delete this comment?") && o.actions.remove(), " danger"));
  }
  return actions;
}

export interface BubbleOptions {
  pinned: boolean;
  canComment: boolean;
  onTogglePin(): void;
  onShowInList(): void;
  actions: Pick<CommentActions, "setResolved">;
}

/** The content of a comment's bubble next to its mark: the comment, its details and thread, and a reply box. */
export function bubbleContent(ctx: PanelContext, parts: CommentParts, a: PageAnnotation, o: BubbleOptions): Node[] {
  const resolved = a.status === "Resolved";
  const pin = h(
    "button",
    {
      className: o.pinned ? "pin-toggle on" : "pin-toggle",
      title: o.pinned ? "Unpin: show only on hover" : "Pin: keep this open",
      onclick: o.onTogglePin,
    },
    icon("pin"),
  );
  const nodes: Node[] = [
    h(
      "div",
      { className: "bubble-head" },
      h("span", { className: "dot", style: { background: a.color } }),
      author(a),
      h("span", { className: "muted", textContent: timeAgo(a.createdAt) }),
      resolved && h("span", { className: "muted", textContent: "· resolved" }),
      h("span", { className: "grow" }),
      pin,
    ),
  ];
  if (a.body) nodes.push(parts.body(a));
  nodes.push(parts.size(a), parts.screenshot(a), parts.details(a), parts.issues(a));
  if (a.replies?.length) nodes.push(parts.replies(a));
  if (o.canComment) {
    nodes.push(
      parts.replyBox(a, "bubble"),
      h(
        "div",
        { className: "row" },
        h("button", {
          className: "link",
          textContent: resolved ? "Reopen" : "Resolve",
          disabled: ctx.busy,
          onclick: () => o.actions.setResolved(!resolved),
        }),
        h("button", { className: "link", textContent: "Show in list", onclick: o.onShowInList }),
      ),
    );
  }
  return nodes;
}
