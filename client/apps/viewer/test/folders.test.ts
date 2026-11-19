import { describe, expect, it } from "vitest";
import type { DocSummary } from "../src/docs/docsApi";
import {
  buildTree,
  canDropFolder,
  countTags,
  folderChain,
  isEmpty,
  isWithin,
  joinPath,
  nameOf,
  parentOf,
} from "../src/docs/sidebar/folders";

const doc = (title: string, folder = "", tags: string[] = []): DocSummary =>
  ({ id: `${folder}/${title}`, title, folder, tags }) as unknown as DocSummary;

describe("folder paths", () => {
  it("joins and splits paths", () => {
    expect(joinPath("", "Guides")).toBe("Guides");
    expect(joinPath("Guides", "Setup")).toBe("Guides/Setup");
    expect(parentOf("Guides/Setup/Linux")).toBe("Guides/Setup");
    expect(parentOf("Guides")).toBe("");
    expect(nameOf("Guides/Setup")).toBe("Setup");
    expect(nameOf("Guides")).toBe("Guides");
  });

  it("lists a folder and those above it, lower-cased", () => {
    expect(folderChain("Guides/Setup/Linux")).toEqual(["guides", "guides/setup", "guides/setup/linux"]);
    expect(folderChain("")).toEqual([]);
  });

  it("knows what's inside a folder, ignoring case", () => {
    expect(isWithin("Guides", "guides")).toBe(true);
    expect(isWithin("Guides/Setup", "Guides")).toBe(true);
    expect(isWithin("GuidesOld", "Guides")).toBe(false);
    expect(isWithin("", "Guides")).toBe(false);
  });

  it("won't drop a folder into itself or below it", () => {
    expect(canDropFolder("Guides", "")).toBe(true);
    expect(canDropFolder("Guides", "Archive")).toBe(true);
    expect(canDropFolder("Guides", "Guides")).toBe(false);
    expect(canDropFolder("Guides", "guides/Setup")).toBe(false);
  });
});

describe("the tree", () => {
  it("puts docs in their folders, creating folders on the way, sorted by name", () => {
    const root = buildTree({
      folders: ["Empty"],
      docs: [doc("Zed", "B/Inner"), doc("Alpha", "B"), doc("Top"), doc("Beta", "B")],
    });
    expect(root.folders.map((f) => f.name)).toEqual(["B", "Empty"]);
    expect(root.docs.map((d) => d.title)).toEqual(["Top"]);
    const b = root.folders[0]!;
    expect(b.docs.map((d) => d.title)).toEqual(["Alpha", "Beta"]);
    expect(b.folders[0]).toMatchObject({ name: "Inner", path: "B/Inner" });
    expect(isEmpty(root.folders[1]!)).toBe(true);
    expect(isEmpty(b)).toBe(false);
  });

  it("treats folders that differ only in case as one", () => {
    const root = buildTree({ folders: ["Notes"], docs: [doc("a", "notes")] });
    expect(root.folders).toHaveLength(1);
    expect(root.folders[0]?.docs).toHaveLength(1);
  });
});

describe("tags", () => {
  it("counts tags, most used first, then by name", () => {
    const docs = [doc("a", "", ["ops", "web"]), doc("b", "", ["web"]), doc("c", "", ["api", "ops"])];
    expect(countTags(docs)).toEqual([
      { tag: "ops", count: 2 },
      { tag: "web", count: 2 },
      { tag: "api", count: 1 },
    ]);
  });
});
