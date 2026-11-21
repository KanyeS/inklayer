/** @jsxImportSource preact */
import { commentParts, stopPropagation } from "@inklayer/overlay";
import type { ComponentChild } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { TrackerChoice } from "../../lib/live";
import { personTitle } from "../../lib/people";
import { sizeDiffers } from "../../lib/viewportMatch";
import { call } from "../call";
import { docUrl, type PageAnnotation, type PanelContext } from "../context";
import { contextSummary, networkLine, timeAgo } from "../format";
import { TRACKER_NAMES } from "../labels";
import { loadScreenshot, paint } from "../page-io";
import { draftBody, EMPTY_DRAFT, SuggestBox, type TextDraft } from "../suggestions";
import { CreateTypedIssue, LinkIssue, NESTING_KINDS } from "./issue-forms";

/** Where a reply box is: in a bubble next to the mark, or in the panel's list. Each keeps its own draft. */
export type ReplyPlace = "bubble" | "panel";

export interface CommentPartsOptions {
  /** Whether the user can comment (and so reply, resolve, create issues) in a project. */
  canCommentIn(projectId: string): boolean;
  /** The organisation a project belongs to, for doc and people suggestions. */
  organizationOf(projectId: string): string | null;
  /** Where an enlarged screenshot is shown. */
  lightboxParent: ParentNode;
  /** "Match their size" was pressed on a comment. */
  matchSize(annotationId: string, width: number, height: number | null, zoom: number | null): void;
}

const HTTPS = /^https:\/\//;

/**
 * The pieces a comment is shown with, shared by its entry in the panel and its bubble next to the mark: the text with
 * links, screenshot, page details, issues, replies and the reply box. Each is null when there's nothing to show.
 * Replies being written and each project's issue trackers are kept here, so they outlast the views that show them.
 */
export class CommentParts {
  readonly #ctx: PanelContext;
  readonly #options: CommentPartsOptions;
  /** Replies being written, by place and comment id. */
  readonly #replies = new Map<string, TextDraft>();
  /** Each project's connected issue trackers, loaded the first time a comment there is shown. */
  readonly #trackers = new Map<string, TrackerChoice[] | "loading">();
  /** Comments with "Link issue" open ("link"), or the create form for a Jira or Azure DevOps tracker (its id). */
  readonly #linking = new Map<string, "link" | { create: string }>();

  constructor(ctx: PanelContext, options: CommentPartsOptions) {
    this.#ctx = ctx;
    this.#options = options;
  }

  /** Whether a reply is being written in a comment's bubble (so the bubble shouldn't close). */
  hasReplyDraft(place: ReplyPlace, annotationId: string): boolean {
    return Boolean(this.#replies.get(`${place}:${annotationId}`)?.text.trim());
  }

  /** Text from a comment or one of its replies, with its @mentions and [[doc]] links. Never parsed as HTML. */
  linkedText(text: string, a: PageAnnotation): ComponentChild {
    const { features, serverUrl } = this.#ctx.init;
    // Keyed by position: the parts of one text never reorder.
    const parts = commentParts(text, a.docLinks ?? [], a.people ?? []).map((part, i) => {
      if ("text" in part) return part.text;
      if ("mention" in part) {
        return (
          <span key={i} className="mention" title={part.fullName ?? part.mention}>
            @{part.mention}
          </span>
        );
      }
      if (!features.docs) return `[[${part.shown}]]`; // with docs turned off, [[links]] are just text
      if (part.docId) {
        return (
          <a
            key={i}
            className="doclink"
            href={docUrl(serverUrl, a.organizationId, part.docId)}
            target="_blank"
            rel="noopener"
            title={`Open the doc "${part.link}"`}
            onClick={stopPropagation}
          >
            {part.shown}
          </a>
        );
      }
      return (
        <span key={i} className="doclink missing" title={`There's no doc called "${part.link}" yet`}>
          {part.shown}
        </span>
      );
    });
    return <p className="body">{parts}</p>;
  }

  /** The comment's own text. */
  body(a: PageAnnotation): ComponentChild {
    return this.linkedText(a.body, a);
  }

  /** The screenshot, drawn on a canvas (images from the extension can't be blocked by the page's content policy). Click to enlarge. */
  screenshot(a: PageAnnotation): ComponentChild {
    if (!this.#ctx.init.features.bugContext) return null;
    const kinds = new Set(a.media?.map((m) => m.kind));
    if (!a.hasScreenshot && kinds.size === 0) return null;
    // The full-page screenshot opens on the comment's page in Inklayer (which signs you in if needed).
    const fullPage = kinds.has("fullpage") && (
      <a
        className="link"
        href={`${this.#ctx.init.serverUrl}/comments/${a.id}`}
        target="_blank"
        rel="noopener noreferrer"
        onClick={stopPropagation}
      >
        Full-page screenshot
      </a>
    );
    return (
      <>
        {a.hasScreenshot && <Screenshot annotationId={a.id} lightboxParent={this.#options.lightboxParent} />}
        {kinds.has("video") && <Recording annotationId={a.id} />}
        {fullPage}
      </>
    );
  }

  /** Issues made from the comment, and "Create issue" when the project has trackers connected. */
  issues(a: PageAnnotation): ComponentChild {
    if (!this.#ctx.init.features.issueTrackers) return null;
    const issues = (a.issues ?? []).filter((issue) => HTTPS.test(issue.url));
    const choices = this.#options.canCommentIn(a.projectId) ? this.#trackersIn(a.projectId) : [];
    // Trackers where the person acts as their own account, which they haven't connected (and there's no shared one).
    const trackers = choices.filter((t) => t.postsAs !== "connect");
    const toConnect = choices.find((t) => t.postsAs === "connect");
    const linking = this.#linking.get(a.id);
    const creating = typeof linking === "object" ? trackers.find((t) => t.id === linking.create) : undefined;
    const close = () => {
      this.#linking.delete(a.id);
      this.#ctx.render();
    };
    const create = this.#createIssue(a, trackers, (t) => {
      this.#linking.set(a.id, { create: t.id });
      this.#ctx.render();
    });
    const toggleLink = () => {
      if (linking === "link") close();
      else {
        this.#linking.set(a.id, "link");
        this.#ctx.render();
      }
    };
    if (issues.length === 0 && !create && !toConnect) return null;
    return (
      <div className="issues" onClick={stopPropagation}>
        {issues.map((issue) => {
          const name = TRACKER_NAMES[issue.kind];
          return (
            <a
              key={issue.id}
              className={`issue ${issue.state}`}
              href={issue.url}
              target="_blank"
              rel="noopener noreferrer"
              title={`${name} ${issue.key} (${issue.state})`}
            >
              {issue.state === "open" ? "●" : issue.state === "closed" && issue.pullRequest ? "✕" : "✓"} {name}{" "}
              {issue.key}
            </a>
          );
        })}
        {create}
        {!create && toConnect && (
          <a
            className="link"
            href={`${this.#ctx.init.serverUrl}/#tracker-accounts`}
            target="_blank"
            rel="noopener noreferrer"
            title={`Issues are created as your own ${TRACKER_NAMES[toConnect.kind]} account`}
            // Asked again next time, so the buttons show once the account is connected.
            onClick={() => this.#trackers.delete(a.projectId)}
          >
            Connect {TRACKER_NAMES[toConnect.kind]} to create issues
          </a>
        )}
        {create && (
          <button
            type="button"
            className="link"
            disabled={this.#ctx.busy}
            aria-expanded={linking === "link"}
            onClick={toggleLink}
          >
            Link issue
          </button>
        )}
        {linking === "link" && trackers.length > 0 && (
          <LinkIssue
            projectId={a.projectId}
            trackers={trackers}
            busy={this.#ctx.busy}
            onLink={(connectionId, reference, addComment, pullRequest) => {
              this.#linking.delete(a.id);
              this.#ctx.mutate(() =>
                call({ type: "live.issueLink", annotationId: a.id, connectionId, reference, addComment, pullRequest }),
              );
            }}
            onCancel={close}
          />
        )}
        {creating && (
          <CreateTypedIssue
            key={creating.id}
            projectId={a.projectId}
            tracker={creating}
            busy={this.#ctx.busy}
            onCreate={(issueType, parent) => {
              this.#linking.delete(a.id);
              this.#ctx.mutate(() =>
                call({ type: "live.issue", annotationId: a.id, connectionId: creating.id, issueType, parent }),
              );
            }}
            onCancel={close}
          />
        )}
      </div>
    );
  }

  /**
   * A button (one tracker) or a menu (several) to create an issue from the comment; null with none connected. Jira and
   * Azure DevOps open a form first (`choose`), for the issue's type and an optional parent.
   */
  #createIssue(a: PageAnnotation, trackers: TrackerChoice[], choose: (t: TrackerChoice) => void): ComponentChild {
    const createIn = (connectionId: string) => {
      const tracker = trackers.find((t) => t.id === connectionId);
      if (tracker && NESTING_KINDS.has(tracker.kind)) choose(tracker);
      else this.#ctx.mutate(() => call({ type: "live.issue", annotationId: a.id, connectionId }));
    };
    const [only] = trackers;
    if (trackers.length === 1 && only) {
      return (
        <button
          type="button"
          className="link"
          title={`Create an issue in ${TRACKER_NAMES[only.kind]}: ${only.name}`}
          disabled={this.#ctx.busy}
          onClick={() => createIn(only.id)}
        >
          Create issue
        </button>
      );
    }
    if (trackers.length < 2) return null;
    const pick = (e: Event) => {
      const value = (e.currentTarget as HTMLSelectElement).value;
      if (value) createIn(value);
    };
    return (
      <select
        className="issue-pick"
        title="Create an issue from this comment"
        disabled={this.#ctx.busy}
        value=""
        onChange={pick}
      >
        <option value="">Create issue in…</option>
        {trackers.map((t) => (
          <option key={t.id} value={t.id}>
            {TRACKER_NAMES[t.kind]}: {t.name}
          </option>
        ))}
      </select>
    );
  }

  #trackersIn(projectId: string): TrackerChoice[] {
    const known = this.#trackers.get(projectId);
    if (known === undefined) {
      this.#trackers.set(projectId, "loading");
      void call<TrackerChoice[]>({ type: "live.trackers", projectId })
        .then((choices) => {
          this.#trackers.set(projectId, choices);
          if (choices.length) this.#ctx.render();
        })
        .catch(() => this.#trackers.set(projectId, []));
    }
    return Array.isArray(known) ? known : [];
  }

  /** "Made at 390px wide · you're at 1440px", with a button to see the page at their size. */
  size(a: PageAnnotation): ComponentChild {
    const width = a.viewportWidth;
    const height = a.context?.viewportHeight ?? null;
    if (!sizeDiffers(width, innerWidth)) return null;
    const zoom = a.context?.zoom ?? null;
    return (
      <div className="row size" onClick={stopPropagation}>
        <span
          className="muted"
          title="Pages often lay out differently at other widths, so the comment may be about a layout you aren't seeing."
        >
          Made at {width}px wide · you're at {innerWidth}px
        </span>
        <button
          type="button"
          className="link"
          disabled={this.#ctx.busy}
          title={
            height
              ? `Resize this window so the page is ${width}×${height}`
              : `Resize this window so the page is ${width}px wide`
          }
          onClick={() => this.#options.matchSize(a.id, width, height, zoom)}
        >
          Match their size
        </button>
      </div>
    );
  }

  /** Browser, window size, the element, console errors and failed requests, folded away. */
  details(a: PageAnnotation): ComponentChild {
    const c = a.context;
    if (!this.#ctx.init.features.bugContext || !c) return null;
    return (
      <details className="context" onClick={stopPropagation}>
        <summary>{contextSummary(c)}</summary>
        {c.selector && <p className="muted">Element: {c.selector}</p>}
        {c.console.length > 0 && (
          <ul>
            {c.console.map((e, i) => (
              <li key={i} className={e.level === "error" ? "error" : ""}>
                {e.level}: {e.message}
              </li>
            ))}
          </ul>
        )}
        {c.network.length > 0 && (
          <ul>
            {c.network.map((n, i) => (
              <li key={i}>{networkLine(n)}</li>
            ))}
          </ul>
        )}
      </details>
    );
  }

  /** How many entries the thread has: replies, and comments on linked issues while issue trackers are on. */
  threadLength(a: PageAnnotation): number {
    return (a.replies?.length ?? 0) + (this.#ctx.init.features.issueTrackers ? (a.issueComments?.length ?? 0) : 0);
  }

  /**
   * The thread, oldest first: replies, with "Delete" where the user may delete them, and comments written on linked
   * issues in the tracker (read-only, marked with the issue).
   */
  replies(a: PageAnnotation): ComponentChild {
    const remove = (e: Event, id: string, version: number) => {
      e.stopPropagation();
      if (window.confirm("Delete this reply?")) this.#ctx.mutate(() => call({ type: "live.replyDelete", id, version }));
    };
    const fromIssues = this.#ctx.init.features.issueTrackers ? (a.issueComments ?? []) : [];
    const thread = [
      ...(a.replies ?? []).map((reply) => ({
        kind: "reply" as const,
        at: reply.createdAt,
        reply,
        issueComment: undefined,
      })),
      ...fromIssues.map((issueComment) => ({
        kind: "issue" as const,
        at: issueComment.createdAt,
        reply: undefined,
        issueComment,
      })),
    ].sort((x, y) => x.at.localeCompare(y.at));
    return (
      <ul className="replies">
        {thread.map(({ kind, reply: r, issueComment: c }) =>
          kind === "issue" ? (
            <li key={c.id} className="reply from-issue">
              <div className="meta">
                <strong>{c.authorName || "Someone"}</strong>
                <span className="muted"> {timeAgo(c.createdAt)} · </span>
                {HTTPS.test(c.issueUrl) ? (
                  <a className="muted" href={c.issueUrl} target="_blank" rel="noopener noreferrer">
                    on {TRACKER_NAMES[c.kind]} {c.issueKey}
                  </a>
                ) : (
                  <span className="muted">
                    on {TRACKER_NAMES[c.kind]} {c.issueKey}
                  </span>
                )}
              </div>
              {c.body}
            </li>
          ) : (
            <li key={r.id} className="reply">
              <div className="meta">
                <strong title={personTitle(r.author)}>{r.author.displayName || "Someone"}</strong>
                <span className="muted"> {timeAgo(r.createdAt)}</span>
                {r.canDelete && (
                  <>
                    {" "}
                    <button
                      type="button"
                      className="link danger"
                      disabled={this.#ctx.busy}
                      onClick={(e) => remove(e, r.id, r.version)}
                    >
                      Delete
                    </button>
                  </>
                )}
              </div>
              {this.linkedText(r.body, a)}
            </li>
          ),
        )}
      </ul>
    );
  }

  /** A box to reply in a comment's thread. Enter sends; Shift+Enter starts a new line; [[ suggests docs. */
  replyBox(a: PageAnnotation, place: ReplyPlace): ComponentChild {
    const key = `${place}:${a.id}`;
    const draft = this.#replies.get(key) ?? EMPTY_DRAFT;
    const setDraft = (next: TextDraft) => {
      this.#replies.set(key, next);
      this.#ctx.render();
    };
    const send = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
      e.preventDefault();
      const body = draftBody(draft);
      if (!body) return;
      setDraft(EMPTY_DRAFT);
      this.#ctx.mutate(() =>
        call({ type: "live.reply", annotationId: a.id, body }).catch((error: unknown) => {
          setDraft(draft); // keep what they wrote
          throw error;
        }),
      );
    };
    return (
      <SuggestBox
        draft={draft}
        onChange={setDraft}
        organizationId={() => this.#options.organizationOf(a.projectId)}
        docsOn={this.#ctx.init.features.docs}
        className="reply-box"
        placeholder="Reply… (Enter to send)"
        rows={1}
        onKeyDown={send}
        onClick={stopPropagation}
      />
    );
  }
}

/** A comment's screenshot on a canvas; removed if it can't be loaded. Click to see it full size. */
function Screenshot({ annotationId, lightboxParent }: { annotationId: string; lightboxParent: ParentNode }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    void loadScreenshot(annotationId).then((bitmap) => {
      if (!bitmap) setMissing(true);
      else if (canvas.current) paint(canvas.current, bitmap);
    });
  }, [annotationId]);
  if (missing) return null;
  const enlarge = (e: Event) => {
    e.stopPropagation();
    void loadScreenshot(annotationId).then((bitmap) => bitmap && showLightbox(lightboxParent, bitmap));
  };
  return (
    <canvas
      ref={canvas}
      className="shot"
      title="Screenshot when this was commented: click to enlarge"
      onClick={enlarge}
    />
  );
}

/**
 * "Play recording", then the recording in a frame: an extension page (player.html), so the page's content policy can't
 * block it and the page can't read it.
 */
function Recording({ annotationId }: { annotationId: string }) {
  const [playing, setPlaying] = useState(false);
  if (!playing) {
    return (
      <button
        type="button"
        className="link"
        onClick={(e) => {
          e.stopPropagation();
          setPlaying(true);
        }}
      >
        ▶ Play recording
      </button>
    );
  }
  return (
    <iframe
      className="recording"
      title="Recording"
      src={chrome.runtime.getURL(`player.html?id=${encodeURIComponent(annotationId)}`)}
      allow="autoplay; fullscreen"
      allowFullScreen
      onClick={stopPropagation}
    />
  );
}

/** The screenshot full size, over everything, until clicked. */
function showLightbox(parent: ParentNode, bitmap: ImageBitmap): void {
  const canvas = document.createElement("canvas");
  canvas.className = "shot-large";
  paint(canvas, bitmap);
  const box = document.createElement("div");
  box.className = "lightbox";
  box.title = "Click to close";
  box.addEventListener("click", () => box.remove());
  box.append(canvas);
  parent.append(box);
}

/**
 * Finds an issue that already exists, by title or a pasted address or number, and links it to the comment. Searches
 * as you type; an empty box lists the open issues.
 */
