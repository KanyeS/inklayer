/** @jsxImportSource preact */
import type { Tool } from "@inklayer/overlay";
import type { ComponentChild } from "preact";
import type { LiveProject } from "../../lib/live";
import { type Scope, type ScopeOption, scopeOptions } from "../format";
import type { ImproveControls } from "../improve";
import { COLORS, TOOLS, toolHint } from "../labels";
import { SuggestBox, type TextDraft } from "../suggestions";
import { improveButton, improveNote } from "./improve";

/** Making a new comment: where it goes, the drawing tools and colours, and the box to write it in. */

export interface ToolbarOptions {
  /** The projects the user can comment in. */
  commentable: LiveProject[];
  target: LiveProject;
  tool: Tool;
  color: string;
  drafting: boolean;
  onTarget(projectId: string): void;
  onTool(tool: Tool): void;
  onColor(color: string): void;
}

/** "New comments go to …" (a menu when there's a choice), the tools, the colours, and what to do next. */
export function toolbar(o: ToolbarOptions): ComponentChild {
  return (
    <>
      {o.commentable.length > 1 ? (
        <label className="target">
          New comments go to
          <select value={o.target.id} onChange={(e) => o.onTarget((e.currentTarget as HTMLSelectElement).value)}>
            {o.commentable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.organizationName} / {p.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="hint">New comments go to {o.target.name}.</p>
      )}
      <div className="tools">
        {TOOLS.map((t) => (
          <button
            type="button"
            key={t.tool}
            className={t.tool === o.tool ? "tool active" : "tool"}
            title={t.title}
            onClick={() => o.onTool(t.tool)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="colors">
        {COLORS.map((c) => (
          <button
            type="button"
            key={c}
            className={c === o.color ? "swatch active" : "swatch"}
            title={c}
            style={{ background: c }}
            onClick={() => o.onColor(c)}
          />
        ))}
      </div>
      {o.tool !== "select" && !o.drafting && <p className="hint">{toolHint(o.tool)}</p>}
    </>
  );
}

/** What the panel says instead of the toolbar when the user can't add comments. */
export function cannotComment(hasProjects: boolean): ComponentChild {
  return (
    <p className="hint">
      {hasProjects
        ? "You can view comments here, but not add them (Viewer)."
        : "You're not in any project yet. Ask an administrator to invite you."}
    </p>
  );
}

/** Whether a scope option is the one chosen. */
export function isChosen(option: ScopeOption, chosen: { includeQuery: boolean; includeHash: boolean }): boolean {
  return option.scope.query === chosen.includeQuery && option.scope.hash === chosen.includeHash;
}

/** "Show this comment on": any version of this page, or only this address (when it has a query or #hash). */
export function scopeChooser(
  href: string,
  chosen: { includeQuery: boolean; includeHash: boolean },
  onChange: (scope: Scope) => void,
): ComponentChild {
  const options = scopeOptions(href);
  if (options.length < 2) return null;
  return (
    <fieldset className="scope">
      <legend>Show this comment on</legend>
      {options.map((option) => (
        <label key={option.address} title={option.address}>
          <input
            type="radio"
            name="inklayer-scope"
            checked={isChosen(option, chosen)}
            onChange={() => onChange(option.scope)}
          />
          <span className="scope-text">
            <span>{option.label}</span>
            <span className="address">{option.address}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

export interface DraftBoxOptions {
  /** The comment box (a SuggestBox, its text kept by the session). */
  input: ComponentChild;
  scope: ComponentChild;
  busy: boolean;
  /** Null when bug context is turned off for this server. */
  attachContext: boolean | null;
  onAttachContext(attach: boolean): void;
  /** Also take a screenshot of the whole page; null when bug context is off. */
  fullPage: boolean | null;
  onFullPage(on: boolean): void;
  /** The recording attached to the comment (its length), undefined if none; null when bug context is off. */
  recording: { seconds: number } | undefined | null;
  /** The recorder's bar is open at the bottom of the page. */
  recorderOpen: boolean;
  /** Opens the recorder's bar. */
  onRecord(): void;
  /** For sites that don't allow recording from the page: the recorder in its own window. */
  onRecordInWindow(): void;
  onCloseRecorder(): void;
  onRemoveRecording(): void;
  /** Issue trackers are on: say that the first line becomes an issue's title. */
  issueTitleHint: boolean;
  /** The Improve button (the local Claude helper); null when it's off. */
  improve?: ImproveControls | null;
  onSave(): void;
  onCancel(): void;
}

/** The new comment being written: the text, where it shows, whether to attach page details, Save and Cancel. */
export function draftBox(o: DraftBoxOptions): ComponentChild {
  return (
    <div className="draft">
      <strong>New comment</strong>
      {o.input}
      {o.issueTitleHint && <p className="hint">The first line becomes the title of any issue made from it.</p>}
      {o.scope}
      {o.attachContext !== null && (
        <label
          className="attach"
          title="A screenshot of this area, your browser and window size, the element, and the page's recent console errors and failed requests (addresses without query strings)"
        >
          <input
            type="checkbox"
            checked={o.attachContext}
            onChange={(e) => o.onAttachContext((e.currentTarget as HTMLInputElement).checked)}
          />
          Attach screenshot and page details
        </label>
      )}
      {o.attachContext && o.fullPage !== null && (
        <label
          className="attach"
          title="Scrolls through the page and takes it all, top to bottom (very long pages are cut off)"
        >
          <input
            type="checkbox"
            checked={o.fullPage}
            onChange={(e) => o.onFullPage((e.currentTarget as HTMLInputElement).checked)}
          />
          Also a full-page screenshot
        </label>
      )}
      {o.recording !== null &&
        (o.recording ? (
          <p className="attach">
            Recording attached ({Math.floor(o.recording.seconds / 60)}:
            {String(o.recording.seconds % 60).padStart(2, "0")}){" "}
            <button type="button" className="link" onClick={o.onRemoveRecording}>
              Remove
            </button>
          </p>
        ) : o.recorderOpen ? (
          <p className="row muted">
            Recording controls are at the bottom of the page.{" "}
            <button type="button" className="link" onClick={o.onRecordInWindow}>
              Use a separate window
            </button>
            <button type="button" className="link" onClick={o.onCloseRecorder}>
              Cancel
            </button>
          </p>
        ) : (
          <button
            type="button"
            className="link"
            title="Record a tab, up to a minute; it's sent with the comment"
            onClick={o.onRecord}
          >
            Record the tab…
          </button>
        ))}
      <div className="row">
        <button type="button" className="primary" disabled={o.busy} onClick={o.onSave}>
          {o.busy ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={o.onCancel}>
          Cancel
        </button>
        {o.improve && improveButton(o.improve)}
      </div>
      {o.improve && improveNote(o.improve)}
    </div>
  );
}

/** The new comment's text box: [[doc]] and @person suggestions, Ctrl+Enter to save, Escape to cancel. */
export function draftInput(o: {
  /** Changes for each new comment, so the box starts afresh. */
  number: number;
  draft: TextDraft;
  onChange(draft: TextDraft): void;
  organizationId(): string | null;
  docsOn: boolean;
  onSave(): void;
  onCancel(): void;
}): ComponentChild {
  const keys = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) o.onSave();
    if (e.key === "Escape") o.onCancel();
  };
  return (
    <SuggestBox
      key={o.number}
      draft={o.draft}
      onChange={o.onChange}
      organizationId={o.organizationId}
      docsOn={o.docsOn}
      placeholder="Add a comment (optional). Ctrl+Enter to save."
      rows={3}
      autoFocus
      onKeyDown={keys}
    />
  );
}
