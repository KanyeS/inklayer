import type { InboxItem } from "./notifications";

/** How notifications read and where they open; shared by the toolbar popup and the panel on pages. */

/** What a notification says happened. */
export const INBOX_TEXT: Readonly<Record<string, string>> = {
  mention: "mentioned you",
  reply: "replied",
  resolved: "resolved your comment",
  issue_closed: "An issue for your comment was closed",
  issue_comment: "New comment on a linked issue",
  access_requested: "asked for access",
  access_granted: "gave you access",
  access_declined: "declined your access request",
};

/** Who a notification is from: nobody for tracker news (a closed issue, a comment there), "Someone" if unknown. */
export function inboxActor(item: Pick<InboxItem, "kind" | "actor">): string | null {
  return item.kind === "issue_closed" || item.kind === "issue_comment" ? null : (item.actor?.displayName ?? "Someone");
}

/** Where a notification opens in the web app: its comment, its doc, its product (access requests), or the home page. */
export function inboxItemUrl(
  item: Pick<InboxItem, "annotationId" | "docId" | "organizationId"> & Partial<Pick<InboxItem, "projectId" | "kind">>,
  serverUrl: string,
): string {
  if (item.annotationId) return `${serverUrl}/comments/${item.annotationId}`;
  if (item.docId) return `${serverUrl}/orgs/${item.organizationId}/docs/${item.docId}`;
  if (item.projectId)
    return `${serverUrl}/projects/${item.projectId}${item.kind === "access_requested" ? "#access" : ""}`;
  return serverUrl;
}
