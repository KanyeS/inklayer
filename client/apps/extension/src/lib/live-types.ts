import type { Rect } from "@inklayer/overlay";
import type { Features } from "./api";
import type { Person } from "./people";

/**
 * The data live mode passes between the background, the server and the content script on web pages, and the requests
 * the content script can make (LiveRequest). Shared by both sides; lib/live.ts handles the requests.
 */

export interface LiveProject {
  id: string;
  name: string;
  organizationId: string;
  organizationName: string;
  myRole: string;
  canComment: boolean;
}

export interface LiveAnnotation {
  id: string;
  pageUrl: string | null;
  kind: string;
  status: "Open" | "Resolved";
  body: string;
  color: string;
  anchor: unknown;
  geometry: unknown;
  version: number;
  author: Person;
  createdAt: string;
  canEdit: boolean;
  canDelete: boolean;
  organizationId: string;
  /** The [[doc]] links in the body, with the doc each one opens (null if it doesn't exist yet). */
  docLinks?: { text: string; docId: string | null; title: string | null }[];
  /** Docs that link this comment. */
  mentionedIn?: { docId: string; title: string }[];
  /** The thread, oldest first. */
  replies?: LiveReply[];
  /** Page details captured with the comment, if the commenter attached them. */
  context?: PageContext | null;
  hasScreenshot?: boolean;
  /** People @mentioned in the comment or its replies, for showing <@id> as names. */
  people?: PersonLookup[];
  /** The commenter's window width when they commented (CSS pixels). */
  viewportWidth?: number;
  /** Issues created from this comment in GitHub, Jira or Linear. */
  issues?: LinkedIssue[];
}

export interface LinkedIssue {
  id: string;
  kind: "github" | "jira" | "linear";
  key: string;
  url: string;
  state: "open" | "closed";
}

/** An issue tracker connected to a project, to create issues in. */
export interface TrackerChoice {
  id: string;
  kind: LinkedIssue["kind"];
  name: string;
}

export interface LiveReply {
  id: string;
  body: string;
  author: Person;
  createdAt: string;
  updatedAt: string;
  version: number;
  canEdit: boolean;
  canDelete: boolean;
}

/** Someone suggested while typing @, or mentioned in a comment. */
export interface PersonLookup {
  id: string;
  displayName: string;
  fullName: string;
}

/** A doc suggested while typing [[ in a comment. */
export interface DocLookup {
  id: string;
  folder: string;
  title: string;
}

/** One project's comments on the page. */
export interface LivePage {
  projectId: string;
  pageUrl: string;
  annotations: LiveAnnotation[];
}

export interface ActivityItem {
  id: string;
  kind: "comments" | "docs" | "signins" | "errors";
  action: string;
  occurredAt: string;
  actor: (Person & { email: string | null }) | null;
  projectId: string | null;
  projectName: string | null;
  pageUrl: string | null;
  annotationId: string | null;
  detail: string | null;
  docId?: string | null;
  docTitle?: string | null;
  organizationId?: string | null;
}

export interface ActivityPage {
  items: ActivityItem[];
  /** The kinds this user may see: comments for everyone, signins for admins, errors for instance admins. */
  kinds: ActivityItem["kind"][];
  nextBefore: string | null;
}

export interface LiveInit {
  projects: LiveProject[];
  pages: LivePage[];
  /** The project new comments went into last time, if the user can still comment there. */
  lastProjectId: string | null;
  /** The Inklayer server, for links to docs and comments. */
  serverUrl: string;
  /** Which major features are on for this server. */
  features: Features;
}

/** Messages from the live content script. The background checks each one against the sender's actual origin. */
export type LiveRequest =
  | { type: "live.check"; url: string }
  | { type: "live.open"; url: string }
  | { type: "live.list"; url: string }
  | {
      type: "live.create";
      projectId: string;
      url: string;
      kind: string;
      body: string;
      color: string;
      anchor: unknown;
      geometry: unknown;
      viewportWidth: number;
      includeQuery: boolean;
      includeHash: boolean;
    }
  | { type: "live.update"; id: string; version: number; status?: "Open" | "Resolved"; body?: string }
  | { type: "live.delete"; id: string; version: number }
  | { type: "live.activity"; thisSite: boolean; kind?: ActivityItem["kind"]; before?: string }
  | { type: "live.font" }
  | { type: "live.docs"; orgId: string; q: string }
  | { type: "live.people"; orgId: string; q: string }
  | { type: "live.context"; annotationId: string; context: PageContext }
  | { type: "live.capture"; annotationId: string; area: Rect; viewportWidth: number }
  | { type: "live.captureResult"; annotationId: string }
  | { type: "live.screenshot"; annotationId: string }
  | { type: "live.reply"; annotationId: string; body: string }
  | { type: "live.replyDelete"; id: string; version: number }
  | { type: "live.trackers"; projectId: string }
  | { type: "live.issue"; annotationId: string; connectionId: string }
  | { type: "live.share"; projectId: string; url: string }
  | { type: "live.matchSize"; width: number; height?: number; left?: number; top?: number }
  | { type: "live.restoreSize" }
  | { type: "live.getZoom" }
  | { type: "live.setZoom"; zoom: number }
  | { type: "live.sizeSaved" }
  | { type: "live.inbox" }
  | { type: "live.inboxRead"; ids?: string[] };

/** What the page looked like when a comment was made: see capture-main.ts and pageDetails.ts. */
export interface PageContext {
  browser: string;
  os: string;
  userAgent: string;
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  /** The tab's zoom (1 = 100%); added by the background, null for older comments. */
  zoom?: number | null;
  selector: string;
  elementHtml: string;
  console: { level: string; message: string; at: string }[];
  network: { method: string; url: string; status: number; ms: number; at: string }[];
}
