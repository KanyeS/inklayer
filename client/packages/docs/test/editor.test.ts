import { describe, expect, it } from "vitest";
import { linkOptions, mentionOptions, offerNewDoc } from "../src/editor/completions";
import { TAG_PATTERN } from "../src/editor/decorations";

describe("[[ suggestions", () => {
  it("links by title, or by path when two docs share the title", () => {
    const docs = [
      { title: "Setup", folder: "Web" },
      { title: "setup", folder: "App" },
      { title: "Plan", folder: "" },
    ];
    expect(linkOptions(docs)).toEqual([
      { target: "Web/Setup", folder: "Web" },
      { target: "App/setup", folder: "App" },
      { target: "Plan", folder: "" },
    ]);
  });

  it("offers a new doc only for a title that doesn't exist", () => {
    expect(offerNewDoc("Plan ", [{ title: "plan" }])).toBe(false);
    expect(offerNewDoc("Roadmap", [{ title: "plan" }])).toBe(true);
    expect(offerNewDoc("  ", [])).toBe(false);
  });
});

describe("@ suggestions", () => {
  it("inserts <@id> and shows the real name when it differs", () => {
    expect(
      mentionOptions([
        { id: "a", displayName: "Ana", fullName: "Ana Lee" },
        { id: "b", displayName: "Bo", fullName: "Bo" },
      ]),
    ).toEqual([
      { label: "@Ana", detail: "Ana Lee", apply: "<@a> " },
      { label: "@Bo", detail: undefined, apply: "<@b> " },
    ]);
  });
});

describe("tags", () => {
  const tags = (text: string) => [...text.matchAll(TAG_PATTERN)].map((m) => m[2]);

  it("finds #tags at a line start or after a space", () => {
    expect(tags("#todo then #web/ui and #2024q1")).toEqual(["#todo", "#web/ui", "#2024q1"]);
  });

  it("ignores headings' #, numbers alone and #s inside words", () => {
    expect(tags("# Heading, issue #42, a#b")).toEqual([]);
  });
});
