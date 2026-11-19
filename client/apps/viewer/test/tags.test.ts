import { describe, expect, it } from "vitest";
import { addTag, extractTags, removeTag, textEdit } from "../src/docs/docMarkdown";

describe("adding and removing #tags in a doc's text", () => {
  it("adds to the doc's line of tags, or on a new line at the end", () => {
    expect(addTag("# Plan\n\nShip it.\n\n#launch", "mobile")).toBe("# Plan\n\nShip it.\n\n#launch #mobile");
    expect(addTag("# Plan\n\nShip it.\n", "launch")).toBe("# Plan\n\nShip it.\n\n#launch");
    expect(addTag("", "#Launch")).toBe("#launch");
    // A heading isn't a line of tags; a tag already there (any case) isn't added again.
    expect(addTag("# Plan", "launch")).toBe("# Plan\n\n#launch");
    expect(addTag("Ship it #Launch", "launch")).toBe("Ship it #Launch");
  });

  it("removes every use of the tag, and lines it leaves empty", () => {
    expect(removeTag("Ship it.\n\n#launch #mobile", "launch")).toBe("Ship it.\n\n#mobile");
    expect(removeTag("Ship it.\n\n#mobile #launch", "launch")).toBe("Ship it.\n\n#mobile");
    expect(removeTag("Ship it.\n\n#Launch", "launch")).toBe("Ship it.");
    expect(removeTag("#launch\n# Plan\nWe #launch on Monday.", "launch")).toBe("# Plan\nWe on Monday.");
    expect(extractTags(removeTag("a #launch/ b", "launch"))).toEqual([]);
  });

  it("leaves code, links to headings and other tags alone", () => {
    const text = "See [[Plan#launch]] and `#launch` and #launchpad.\n\n```\n#launch\n```\n#launch";
    expect(removeTag(text, "launch")).toBe("See [[Plan#launch]] and `#launch` and #launchpad.\n\n```\n#launch\n```");
  });

  it("turns a change into one small edit, so the live doc keeps everything else", () => {
    expect(textEdit("Ship it.\n\n#launch", "Ship it.\n\n#launch #mobile")).toEqual({ from: 17, to: 17, insert: " #mobile" });
    expect(textEdit("a #launch b", "a b")).toEqual({ from: 2, to: 10, insert: "" });
    expect(textEdit("same", "same")).toBeNull();
  });
});
