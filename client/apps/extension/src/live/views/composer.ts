import { h, type Tool } from "@inklayer/overlay";
import type { LiveProject } from "../../lib/live";
import { type Scope, type ScopeOption, scopeOptions } from "../format";
import { COLORS, TOOLS, toolHint } from "../labels";

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
export function toolbar(o: ToolbarOptions): Node[] {
  const parts: Node[] = [];
  if (o.commentable.length > 1) {
    const select = h("select", { onchange: () => o.onTarget(select.value) });
    for (const p of o.commentable) {
      select.append(
        h("option", { value: p.id, textContent: `${p.organizationName} / ${p.name}`, selected: p.id === o.target.id }),
      );
    }
    parts.push(h("label", { className: "target" }, "New comments go to", select));
  } else {
    parts.push(h("p", { className: "hint", textContent: `New comments go to ${o.target.name}.` }));
  }

  const tools = h(
    "div",
    { className: "tools" },
    ...TOOLS.map((t) =>
      h("button", {
        className: t.tool === o.tool ? "tool active" : "tool",
        textContent: t.label,
        title: t.title,
        onclick: () => o.onTool(t.tool),
      }),
    ),
  );
  const colors = h(
    "div",
    { className: "colors" },
    ...COLORS.map((c) =>
      h("button", {
        className: c === o.color ? "swatch active" : "swatch",
        title: c,
        style: { background: c },
        onclick: () => o.onColor(c),
      }),
    ),
  );
  parts.push(tools, colors);
  if (o.tool !== "select" && !o.drafting) parts.push(h("p", { className: "hint", textContent: toolHint(o.tool) }));
  return parts;
}

/** What the panel says instead of the toolbar when the user can't add comments. */
export function cannotComment(hasProjects: boolean): HTMLParagraphElement {
  return h("p", {
    className: "hint",
    textContent: hasProjects
      ? "You can view comments here, but not add them (Viewer)."
      : "You're not in any project yet. Ask an administrator to invite you.",
  });
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
): Node | null {
  const options = scopeOptions(href);
  if (options.length < 2) return null;
  const fieldset = h("fieldset", { className: "scope" }, h("legend", { textContent: "Show this comment on" }));
  for (const option of options) {
    const input = h("input", {
      type: "radio",
      name: "inklayer-scope",
      checked: isChosen(option, chosen),
      onchange: () => onChange(option.scope),
    });
    const text = h(
      "span",
      { className: "scope-text" },
      h("span", { textContent: option.label }),
      h("span", { className: "address", textContent: option.address }),
    );
    fieldset.append(h("label", { title: option.address }, input, text));
  }
  return fieldset;
}

export interface DraftBoxOptions {
  /** The comment box (kept by the session across re-renders), already wrapped with its suggestions. */
  input: HTMLElement;
  scope: Node | null;
  busy: boolean;
  /** Null when bug context is turned off for this server. */
  attachContext: boolean | null;
  onAttachContext(attach: boolean): void;
  onSave(): void;
  onCancel(): void;
}

/** The new comment being written: the text, where it shows, whether to attach page details, Save and Cancel. */
export function draftBox(o: DraftBoxOptions): HTMLElement {
  const attach =
    o.attachContext !== null &&
    h(
      "label",
      {
        className: "attach",
        title:
          "A screenshot of this area, your browser and window size, the element, and the page's recent console errors and failed requests (addresses without query strings)",
      },
      h("input", {
        type: "checkbox",
        checked: o.attachContext,
        onchange: (e: Event) => o.onAttachContext((e.target as HTMLInputElement).checked),
      }),
      "Attach screenshot and page details",
    );
  return h(
    "div",
    { className: "draft" },
    h("strong", { textContent: "New comment" }),
    o.input,
    o.scope,
    attach,
    h(
      "div",
      { className: "row" },
      h("button", {
        className: "primary",
        textContent: o.busy ? "Saving…" : "Save",
        disabled: o.busy,
        onclick: o.onSave,
      }),
      h("button", { textContent: "Cancel", onclick: o.onCancel }),
    ),
  );
}
