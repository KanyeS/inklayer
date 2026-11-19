/**
 * The markdown cheat sheet, as in the app: the same examples (viewer/src/docs/markdownExamples.ts), previews drawn by
 * the app's renderer, and buttons to insert an example into the editor (applied to the selection) or copy it.
 */
import { enhance } from "../../../../viewer/src/docs/enhance";
import type { FormatId } from "../../../../viewer/src/docs/formatting";
import { MARKDOWN_EXAMPLES } from "../../../../viewer/src/docs/markdownExamples";
import { renderMarkdown } from "../../../../viewer/src/docs/reading";
import { h } from "../../lib/dom";
import { icon } from "./icons";

const PREVIEW = { doc: () => ({ href: "#" }), person: () => ({ displayName: "Alex", fullName: "Alex Rivera" }) };

export function cheatSheet(onInsert: (format: FormatId) => void): { open: () => void } {
  const close = h("button", { type: "button", className: "sheet-close", title: "Close", ariaLabel: "Close" }, icon("x"));
  const body = h("div", { className: "sheet-body" });
  const dialog = h("dialog", { className: "cheat-sheet" },
    h("div", { className: "sheet-head" },
      h("div", {}, h("h4", { textContent: "Markdown cheat sheet" }),
        h("p", { textContent: "Select something in the note, then Insert applies an example to it. Or copy one and paste it." })),
      close),
    body);
  document.body.append(dialog);
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (e) => e.target === dialog && dialog.close());

  let built = false;
  const build = () => {
    built = true;
    for (const section of MARKDOWN_EXAMPLES) {
      const rows = h("div", { className: "sheet-rows" });
      body.append(h("h5", { textContent: section.title }), rows);
      for (const example of section.examples) {
        const preview = h("div", { className: "doc-reading sheet-preview" });
        preview.innerHTML = example.preview ?? renderMarkdown(example.snippet, PREVIEW);
        preview.addEventListener("click", (e) => e.preventDefault());
        const actions = h("div", { className: "sheet-actions" });
        if (example.format) {
          const insert = h("button", { type: "button", title: "Insert into the note", ariaLabel: `Insert ${example.label}` }, icon("corner-down-left"));
          insert.addEventListener("click", () => {
            dialog.close();
            onInsert(example.format!);
          });
          actions.append(insert);
        }
        if (example.copy !== false) {
          const copy = h("button", { type: "button", title: "Copy", ariaLabel: `Copy ${example.label}` }, icon("copy"));
          copy.addEventListener("click", () => {
            void navigator.clipboard.writeText(example.snippet);
            copy.classList.add("done");
            setTimeout(() => copy.classList.remove("done"), 1200);
          });
          actions.append(copy);
        }
        const snippet = example.copy === false ? h("p", { className: "sheet-how", textContent: example.snippet }) : h("pre", { textContent: example.snippet });
        rows.append(h("div", { className: "sheet-row" },
          h("div", { className: "sheet-label", textContent: example.label }),
          snippet,
          h("div", {}, preview, example.note ? h("p", { className: "sheet-note", textContent: example.note }) : null),
          actions));
      }
    }
    void enhance(body);
  };

  return {
    open: () => {
      if (!built) build();
      dialog.showModal();
    },
  };
}
