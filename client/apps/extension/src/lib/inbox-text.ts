import type { InboxItem } from "./notifications";

/** How notifications read and where they open; shared by the toolbar popup and the panel on pages. */

/** What a notification says happened. */
export const INBOX_TEXT: Readonly<Record<string, string>> = {
  mention: "mentioned you",
  reply: "replied",
  resolved: "resolved your comment",
  issue_closed: "An issue for your comment was closed",
  issue_comment: "New comment on a linked issue",
};

/** Who a notification is from: nobody for tracker news (a closed issue, a comment there), "Someone" if unknown. */
export function inboxActor(item: Pick<InboxItem, "kind" | "actor">): string | null {
  return item.kind === "issue_closed" || item.kind === "issue_comment" ? null : (item.actor?.displayName ?? "Someone");
}

/** Where a notification opens in the web app: its comment, its doc, or the home page. */
export function inboxItemUrl(
  item: Pick<InboxItem, "annotationId" | "docId" | "organizationId">,
  serverUrl: string,
): string {
  if (item.annotationId) return `${serverUrl}/comments/${item.annotationId}`;
  if (item.docId) return `${serverUrl}/orgs/${item.organizationId}/docs/${item.docId}`;
  return serverUrl;
}
