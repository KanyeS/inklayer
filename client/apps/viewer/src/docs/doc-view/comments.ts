import { hostOf } from "@/lib/format";
import { type CommentInfo, docsApi } from "../docsApi";
import { commentCardHeading } from "./docViewText";

/** Comments linked from docs, loaded once per page view. Null: deleted, or in a project the reader can't see. */
const commentCache = new Map<string, Promise<CommentInfo | null>>();

export function loadComment(id: string): Promise<CommentInfo | null> {
  let entry = commentCache.get(id);
  if (!entry) {
    entry = docsApi.comment(id).catch(() => null);
    commentCache.set(id, entry);
  }
  return entry;
}

function span(className: string, text: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = className;
  el.textContent = text;
  return el;
}

/** A linked page comment, as a card in reading view. Built with textContent, never parsed. */
export function commentCard(comment: CommentInfo | null, id: string): HTMLElement {
  const card = document.createElement("a");
  card.className = "doc-comment-card";
  card.href = `/comments/${id}`;
  if (!comment) {
    card.textContent = "A page comment you can't see (or that was deleted).";
    card.classList.add("missing");
    return card;
  }
  card.append(span("doc-comment-card-head", commentCardHeading(comment)), span("doc-comment-card-body", comment.body));
  if (comment.pageUrl) {
    card.append(span("doc-comment-card-page", hostOf(comment.pageUrl) + new URL(comment.pageUrl).pathname));
  }
  return card;
}
