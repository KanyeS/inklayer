import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { type FormatId, formatSpec, tableFrom } from "../src/formatting";

/** Runs an action on `doc` with [from, to] selected; returns the text and what's selected after. */
function run(doc: string, from: number, to: number, id: FormatId) {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.range(from, to),
    extensions: EditorState.allowMultipleSelections.of(true),
  });
  const after = state.update(formatSpec(state, id)!).state;
  const sel = after.selection.main;
  return { text: after.doc.toString(), selected: after.sliceDoc(sel.from, sel.to) };
}
const all = (doc: string, id: FormatId) => run(doc, 0, doc.length, id).text;

describe("quick formatting in the doc editor", () => {
  it("wraps the selection, and unwraps it again", () => {
    expect(run("Ship it now", 5, 7, "bold")).toEqual({ text: "Ship **it** now", selected: "it" });
    expect(run("Ship **it** now", 7, 9, "bold")).toEqual({ text: "Ship it now", selected: "it" });
    expect(run("Ship it", 7, 7, "italic")).toEqual({ text: "Ship it*italic text*", selected: "italic text" });
    expect(run("See Roadmap", 4, 11, "doclink").text).toBe("See [[Roadmap]]");
    expect(run("Docs", 0, 4, "link")).toEqual({ text: "[Docs](https://)", selected: "https://" });
  });

  it("checkboxes: every selected line gets one (a bullet becomes one), and they come off again", () => {
    expect(all("Retest Safari\n- Fix banner\n\nShip", "task")).toBe(
      "- [ ] Retest Safari\n- [ ] Fix banner\n\n- [ ] Ship",
    );
    expect(all("- [ ] Retest\n- [x] Fix", "task")).toBe("Retest\nFix");
    expect(run("Retest", 0, 0, "task").text).toBe("- [ ] Retest");
  });

  it("other line prefixes: headings replace headings, numbers count up, quotes toggle", () => {
    expect(all("## Plan", "h1")).toBe("# Plan");
    expect(all("# Plan", "h1")).toBe("Plan");
    expect(all("a\nb\nc", "numbered")).toBe("1. a\n2. b\n3. c");
    expect(all("- a\n- b", "numbered")).toBe("1. a\n2. b");
    expect(all("a\nb", "quote")).toBe("> a\n> b");
    expect(all("> a\n> b", "quote")).toBe("a\nb");
  });

  it("tables: an empty one, or one made from the selected lines", () => {
    expect(run("Intro", 5, 5, "table").text).toBe("Intro\n\n| Column | Column |\n| --- | --- |\n|  |  |\n|  |  |");
    expect(all("Page, Status\nCheckout, Fixed\nCart, Open", "table")).toBe(
      "| Page | Status |\n| --- | --- |\n| Checkout | Fixed |\n| Cart | Open |",
    );
    expect(tableFrom("Name\tRole\nRosie\tQA")).toBe("| Name | Role |\n| --- | --- |\n| Rosie | QA |");
  });

  it("blocks: code and diagrams around the selection, dividers and callouts on their own lines", () => {
    expect(all("const a = 1;", "codeblock")).toBe("```\nconst a = 1;\n```");
    expect(run("", 0, 0, "mermaid").text.startsWith("```mermaid\nflowchart LR")).toBe(true);
    expect(run("Above", 5, 5, "divider").text).toBe("Above\n\n---");
    expect(run("", 0, 0, "callout")).toEqual({ text: "> [!note] Title\n> ", selected: "Title" });
    expect(all("Check Safari", "callout")).toBe("> [!note]\n> Check Safari");
  });

  it("footnotes, tags and mentions", () => {
    expect(run("Tested.", 7, 7, "footnote").text).toBe("Tested.[^1]\n\n[^1]: ");
    expect(run("Tested.[^1]\n\n[^1]: Safari", 7, 7, "footnote").text).toBe("Tested.[^2][^1]\n\n[^1]: Safari\n\n[^2]: ");
    expect(run("Bug fix", 0, 7, "tag").text).toBe("#bug-fix");
    expect(run("Ask", 3, 3, "mention").text).toBe("Ask @");
  });
});
