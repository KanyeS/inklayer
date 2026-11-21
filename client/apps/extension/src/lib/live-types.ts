import type {
  ActivityItemResponse,
  ActivityResponse,
  DocSummaryResponse,
  LivePageAnnotationsResponse,
  LiveProjectResponse,
  PullRequestPageResponse,
} from "@inklayer/api";
import type { AnnotationKind, Rect } from "@inklayer/overlay";
import type { Features } from "./api";
import type { CarriedDraft } from "./recorder-protocol";

/**
 * The data live mode passes between the background, the server and the content script on web pages, and the requests
 * the content script can make (LiveRequest). Shared by both sides; lib/live.ts handles the requests.
 */

export type {
  AnnotationResponse as LiveAnnotation,
  FoundIssue,
  IssueCommentResponse as IssueComment,
  IssueResponse as LinkedIssue,
  LivePageAnnotationsResponse as LivePage,
  LiveProjectResponse as LiveProject,
  PersonResponse as PersonLookup,
  PullRequestPageResponse as PullRequestPage,
  ReplyResponse as LiveReply,
  TrackerChoiceResponse as TrackerChoice,
} from "@inklayer/api";

/** A doc suggested while typing [[ in a comment. */
export type DocLookup = Pick<DocSummaryResponse, "id" | "folder" | "title">;
export type ActivityPage = ActivityResponse;
export type ActivityItem = ActivityItemResponse;

export interface LiveInit {
  projects: LiveProjectResponse[];
  pages: LivePageAnnotationsResponse[];
  /** The project new comments went into last time, if the user can still comment there. */
  lastProjectId: string | null;
  /** The Inklayer server, for links to docs and comments. */
  serverUrl: string;
  /** Which major features are on for this server. */
  features: Features;
  /** On a pull request's page: the Inklayer comments linked to it. */
  pullRequest: PullRequestPageResponse | null;
}

/** Messages from the live content script. The background checks each one against the sender's actual origin. */
export type LiveRequest =
  | { type: "live.check"; url: string }
  | { type: "live.open"; url: string }
  | { type: "live.list"; url: string }
  | { type: "live.pullRequest"; url: string }
  | {
      type: "live.create";
      projectId: string;
      url: string;
      kind: AnnotationKind;
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
  | { type: "live.fullPageStart"; annotationId: string; width: number; height: number }
  | { type: "live.fullPageFrame"; annotationId: string; y: number }
  | { type: "live.fullPageEnd"; annotationId: string }
  | { type: "live.fullPageCancel"; annotationId: string }
  | { type: "live.recordStart" }
  | { type: "live.recordInWindow" }
  | { type: "live.recorder" }
  | { type: "live.recorderDraft"; draft: CarriedDraft | null }
  | { type: "live.recorderStop" }
  | { type: "live.recorderClear" }
  | { type: "live.recordingUpload"; annotationId: string; recordingId: string }
  | { type: "live.recordingDiscard"; recordingId: string }
  | { type: "live.screenshot"; annotationId: string }
  | { type: "live.reply"; annotationId: string; body: string }
  | { type: "live.replyDelete"; id: string; version: number }
  | { type: "live.trackers"; projectId: string }
  | { type: "live.issue"; annotationId: string; connectionId: string; parent?: string; issueType?: string }
  | { type: "live.issueTypes"; projectId: string; connectionId: string }
  | { type: "live.issueSearch"; projectId: string; connectionId: string; q: string; pullRequests?: boolean }
  | {
      type: "live.issueLink";
      annotationId: string;
      connectionId: string;
      reference: string;
      addComment: boolean;
      pullRequest?: boolean;
    }
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
  /** The commenter's time zone (IANA) and offset from UTC in minutes. */
  timeZone?: string;
  utcOffsetMinutes?: number;
  /** The page's script file names: which build of the site it was. */
  scripts?: string[];
}
