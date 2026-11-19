import { describe, expect, it } from "vitest";
import {
  commentCardHeading,
  commentChipLabel,
  headingText,
  presenceStatus,
  setTaskChecked,
  statusDotClass,
  statusLabel,
} from "../src/docs/doc-view/docViewText";
import type { CommentInfo } from "../src/docs/docsApi";

const comment = (overrides: Partial<CommentInfo> = {}): CommentInfo => ({
  id: "c1",
  organizationId: "o1",
  projectId: "p1",
  projectName: "Website",
  pageUrl: "https://site.test/",
  body: "The button is misaligned",
  status: "Open",
  author: { id: "u1", displayName: "Ann" } as CommentInfo["author"],
  createdAt: "",
  mentionedIn: [],
  ...overrides,
});

describe("save status", () => {
  it.each([
    ["live", true, "Live · saved automatically"],
    ["live", false, "Live · read only"],
    ["connecting", true, "Connecting…"],
    ["offline", true, "Offline · edits kept"],
    ["closed", false, "Closed"],
  ] as const)("%s (can edit: %s) says %s", (status, canEdit, label) => {
    expect(statusLabel(status, canEdit)).toBe(label);
  });

  it("colours the dot by status", () => {
    expect(statusDotClass("live")).toBe("bg-emerald-500");
    expect(statusDotClass("connecting")).toBe("bg-amber-500");
    expect(statusDotClass("offline")).toBe("bg-muted-foreground");
    expect(statusDotClass("closed")).toBe("bg-muted-foreground");
  });

  it("counts a closed session as offline for live cursors", () => {
    expect(presenceStatus("live")).toBe("live");
    expect(presenceStatus("connecting")).toBe("connecting");
    expect(presenceStatus("offline")).toBe("offline");
    expect(presenceStatus("closed")).toBe("offline");
  });
});

describe("linked comments", () => {
  it("labels a chip with the author and the start of the comment", () => {
    expect(commentChipLabel(comment())).toBe("Ann: The button is misaligned");
    expect(commentChipLabel(comment({ body: "x".repeat(61) }))).toBe(`Ann: ${"x".repeat(60)}…`);
    expect(commentChipLabel(null)).toBe("Comment you can't see");
  });

  it("heads a card with the author, project and whether it's resolved", () => {
    expect(commentCardHeading(comment())).toBe("💬 Ann · Website");
    expect(commentCardHeading(comment({ status: "Resolved" }))).toBe("💬 Ann · Website · resolved");
  });
});

describe("ticking tasks", () => {
  const text = "# Plan\n- [ ] write\n- [x] test\n";

  it("ticks and unticks the task on a line", () => {
    expect(setTaskChecked(text, 1, true)).toBe("# Plan\n- [x] write\n- [x] test\n");
    expect(setTaskChecked(text, 2, false)).toBe("# Plan\n- [ ] write\n- [ ] test\n");
  });

  it("changes only the first box on the line", () => {
    expect(setTaskChecked("- [ ] a [ ] b", 0, true)).toBe("- [x] a [ ] b");
  });

  it("ignores lines that don't exist", () => {
    expect(setTaskChecked(text, 9, true)).toBeNull();
    expect(setTaskChecked(text, -1, true)).toBeNull();
    expect(setTaskChecked(text, Number.NaN, true)).toBeNull();
  });
});

describe("headings", () => {
  it("matches a heading with or without its #s", () => {
    expect(headingText("## Setup ")).toBe("Setup");
    expect(headingText("Setup")).toBe("Setup");
  });
});
