import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { extractLinks, extractTags, headings, relinkEdits } from "../src/docs/docMarkdown";
import { fuzzyScore } from "../src/docs/fuzzy";
import { renderMarkdown } from "../src/docs/reading";

describe("doc links and tags (same rules as the server)", () => {
  it("parses Obsidian links", () => {
    const links = extractLinks("See [[Roadmap]], [[Research/Interviews|the interviews]], [[Launch plan#Risks]] and ![[Diagram]].");
    expect(links.map((l) => l.target)).toEqual(["Roadmap", "Research/Interviews", "Launch plan", "Diagram"]);
    expect(links[1]!.alias).toBe("the interviews");
    expect(links[2]!.heading).toBe("Risks");
    expect(links[3]!.embed).toBe(true);
  });

  it("parses comment links", () => {
    const id = "0193a6b2-1111-7222-8333-944455556666";
    expect(extractLinks(`As in [[comment:${id}]]`)[0]!.commentId).toBe(id);
    expect(extractLinks("[[comment:nope]]")).toEqual([]);
  });

  it("ignores code", () => {
    const text = "Before [[Real]]\n```\n[[Not a link]] #nottag\n```\nInline `[[No]] #no` and #yes";
    expect(extractLinks(text).map((l) => l.target)).toEqual(["Real"]);
    expect(extractTags(text)).toEqual(["yes"]);
  });

  it.each([
    ["#idea and #Project/Alpha", ["idea", "project/alpha"]],
    ["# Heading\n## Another", []],
    ["issue #123 page#anchor https://x.test/#frag", []],
    ["#2024-review", ["2024-review"]],
    ["[[Doc#Heading]] #real", ["real"]],
  ])("tags in %j", (text, expected) => {
    expect(extractTags(text)).toEqual(expected);
  });

  it("finds headings for the outline", () => {
    expect(headings("# One\ntext\n## Two ##\n```\n# not\n```")).toEqual([
      { level: 1, text: "One", from: 0 },
      { level: 2, text: "Two", from: 11 },
    ]);
  });

  it("rewrites links after a rename, keeping headings and aliases", () => {
    const text = "[[Plan]] and [[Plan#Risks|risks]] and [[Old/Plan]] but not [[Planning]]";
    let result = text;
    for (const e of relinkEdits(text, (key) => key === "plan" || key === "old/plan", (l) => (l.target!.includes("/") ? "New/Roadmap" : "Roadmap"))) {
      result = result.slice(0, e.from) + e.insert + result.slice(e.to);
    }
    expect(result).toBe("[[Roadmap]] and [[Roadmap#Risks|risks]] and [[New/Roadmap]] but not [[Planning]]");
  });
});

describe("reading view", () => {
  const render = (text: string) => renderMarkdown(text, { doc: (l) => (l.target === "Roadmap" ? { href: "/orgs/o/docs/1" } : null) });

  it("never passes raw HTML or unsafe links through", () => {
    const html = render(`<img src=x onerror=alert(1)> [x](javascript:alert(1)) ![y](javascript:alert(2))`);
    expect(html).not.toContain("<img src=x");
    // Rejected links stay as plain text; what matters is that nothing becomes a link or an image source.
    expect(html).not.toMatch(/(href|src)="javascript:/i);
    expect(html).not.toContain("<a");
    expect(html).toContain("&lt;img");
  });

  it("links docs, marks missing ones, and shows tags and comments", () => {
    const html = render("[[Roadmap]] [[Missing]] #idea [[comment:0193a6b2-1111-7222-8333-944455556666]]");
    expect(html).toContain('href="/orgs/o/docs/1"');
    expect(html).toContain('data-create="Missing"');
    expect(html).toContain('data-tag="idea"');
    expect(html).toContain('data-comment-id="0193a6b2-1111-7222-8333-944455556666"');
  });
});

describe("quick switcher", () => {
  it("ranks prefixes, then substrings, then scattered letters", () => {
    expect(fuzzyScore("road", "Roadmap")!).toBeGreaterThan(fuzzyScore("map", "Roadmap")!);
    expect(fuzzyScore("map", "Roadmap")!).toBeGreaterThan(fuzzyScore("rdmp", "Roadmap")!);
    expect(fuzzyScore("xyz", "Roadmap")).toBeNull();
  });
});

/**
 * The server's rules, in memory: numbered updates per doc, and snapshots accepted only if at least as new as the stored
 * one and only up to updates that exist. Editors snapshot up to the highest number they have every update for.
 */
class FakeServer {
  state: Uint8Array | null = null;
  snapshotSeq = 0;
  lastSeq = 0;
  updates = new Map<number, Uint8Array>();

  update(bytes: Uint8Array): number {
    this.updates.set(++this.lastSeq, bytes);
    return this.lastSeq;
  }

  snapshot(state: Uint8Array, upTo: number): boolean {
    if (upTo < this.snapshotSeq || upTo > this.lastSeq) return false;
    this.state = state;
    this.snapshotSeq = upTo;
    for (const seq of [...this.updates.keys()]) if (seq <= upTo) this.updates.delete(seq);
    return true;
  }

  load(): Y.Doc {
    const doc = new Y.Doc();
    if (this.state) Y.applyUpdate(doc, this.state);
    for (const seq of [...this.updates.keys()].sort((a, b) => a - b)) Y.applyUpdate(doc, this.updates.get(seq)!);
    return doc;
  }
}

describe("co-editing through the server's rules", () => {
  it("converges, and snapshots from editors who are behind lose nothing", () => {
    const server = new FakeServer();
    const editors = [new Y.Doc(), new Y.Doc(), new Y.Doc()];
    const contiguous = [0, 0, 0];
    const applied = [new Set<number>(), new Set<number>(), new Set<number>()];
    const markApplied = (i: number, seq: number) => {
      applied[i]!.add(seq);
      while (applied[i]!.has(contiguous[i]! + 1)) contiguous[i]!++;
    };
    // Updates waiting to be delivered to each editor, so they can arrive late and out of order.
    const inbox: { seq: number; bytes: Uint8Array }[][] = [[], [], []];

    const type = (i: number, at: number, text: string) => {
      let update: Uint8Array | null = null;
      const capture = (u: Uint8Array) => (update = u);
      editors[i]!.on("update", capture);
      editors[i]!.getText("t").insert(Math.min(at, editors[i]!.getText("t").length), text);
      editors[i]!.off("update", capture);
      const seq = server.update(update!);
      markApplied(i, seq);
      for (let j = 0; j < editors.length; j++) if (j !== i) inbox[j]!.push({ seq, bytes: update! });
    };
    const deliver = (i: number, count = Infinity) => {
      const batch = inbox[i]!.splice(0, count).reverse(); // out of order on purpose
      for (const { seq, bytes } of batch) {
        Y.applyUpdate(editors[i]!, bytes);
        markApplied(i, seq);
      }
    };
    const snapshot = (i: number) => server.snapshot(Y.encodeStateAsUpdate(editors[i]!), contiguous[i]!);

    type(0, 0, "Hello");
    type(1, 0, "World ");
    type(2, 0, "!");
    deliver(1, 1); // editor 1 has seen only some of the others' edits
    expect(snapshot(1)).toBe(true);
    type(0, 5, " there");
    deliver(2);
    snapshot(2);
    expect(snapshot(1)).toBe(false); // older than what's stored now
    for (let i = 0; i < 3; i++) deliver(i);

    const texts = editors.map((d) => d.getText("t").toString());
    expect(new Set(texts).size).toBe(1);
    expect(server.load().getText("t").toString()).toBe(texts[0]);
    for (const piece of ["Hello", " there", "World ", "!"]) expect(texts[0]).toContain(piece);
  });
});

describe("editor", () => {
  it("keeps CodeMirror and the shared text in step both ways", async () => {
    const { Awareness } = await import("y-protocols/awareness");
    const { createEditor } = await import("../src/docs/editor");
    const doc = new Y.Doc();
    const text = doc.getText("content");
    text.insert(0, "# Plan\nSee [[Roadmap]] #idea");
    const session = { text, awareness: new Awareness(doc), canEdit: true } as unknown as import("../src/docs/collab").DocSession;
    const parent = document.createElement("div");
    document.body.append(parent);
    const editor = createEditor(parent, session, {
      titles: () => [{ title: "Roadmap", folder: "" }],
      openLink: () => undefined,
      openComment: () => undefined,
      commentLabel: () => undefined,
      onPointer: () => undefined,
    });

    expect(editor.view.state.doc.toString()).toBe("# Plan\nSee [[Roadmap]] #idea");
    expect(parent.querySelector(".cm-wikilink")?.textContent).toBe("[[Roadmap]]");
    expect(parent.querySelector(".cm-doctag")?.textContent).toBe("#idea");

    // Someone else's edit arrives in the shared text…
    text.insert(text.length, "\nmore");
    expect(editor.view.state.doc.toString()).toBe("# Plan\nSee [[Roadmap]] #idea\nmore");

    // …and typing here goes into the shared text, where comment links become chips.
    editor.view.dispatch({ changes: { from: 0, insert: "[[comment:0193a6b2-1111-7222-8333-944455556666]] " } });
    expect(text.toString().startsWith("[[comment:")).toBe(true);
    editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length } });
    expect(parent.querySelector(".cm-comment-chip")?.textContent).toContain("Comment");

    editor.setEditable(false);
    expect(editor.view.state.readOnly).toBe(true);
    editor.destroy();
  });
});

describe("edits made on the server (YDotNet / yrs)", () => {
  // The same document as the server's YjsCompatibilityTests, and an edit YDotNet made to it: "!" after the emoji.
  const fromYjs = "AQOSIQAEAQdjb250ZW50AiMggZIhAQGEkiECKMOpbGxvIPCfkYsgd29ybGQKU2Vjb25kIGxpbmUgW1tSb2FkbWFwXV0BkiEBAgE=";
  const fromServer = "AQGxndT844CqCwDEkiEJkiEKASEBkiEBAgE=";
  const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  it("apply in the browser at the same place", () => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, bytes(fromYjs));
    Y.applyUpdate(doc, bytes(fromServer));
    expect(doc.getText("content").toString()).toBe("# éllo 👋! world\nSecond line [[Roadmap]]");
  });
});
