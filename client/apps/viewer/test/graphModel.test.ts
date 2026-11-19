import { describe, expect, it } from "vitest";
import type { DocGraph, DocTree } from "../src/docs/docsApi";
import {
  buildGraph,
  labelVisible,
  MAX_ZOOM,
  MIN_ZOOM,
  matches,
  type Node,
  neighboursOf,
  nodeAt,
  radius,
  shortLabel,
  toWorld,
  zoomView,
} from "../src/docs/graph/graphModel";

const graph = {
  nodes: [
    { id: "d:1", kind: "doc", label: "Plan", docId: "1" },
    { id: "d:2", kind: "doc", label: "Notes", docId: "2" },
    { id: "d:3", kind: "doc", label: "Ops", docId: "3" },
    { id: "c:9", kind: "comment", label: "Fix the button", annotationId: "9" },
  ],
  edges: [
    { source: "d:1", target: "d:2" },
    { source: "c:9", target: "d:1" },
  ],
} as unknown as DocGraph;

const tree = {
  docs: [
    { id: "1", tags: ["web"] },
    { id: "2", tags: [] },
    { id: "3", tags: ["ops"] },
  ],
  tags: [{ tag: "web", count: 1, icon: "globe", color: "#00f" }],
} as unknown as DocTree;

const all = { showComments: true, showTags: false, onlyTags: new Set<string>() };

describe("building the graph", () => {
  it("has every doc and comment, with links and how linked each is", () => {
    const { nodes, edges } = buildGraph("o1", graph, tree, all);
    expect(nodes.map((n) => n.id)).toEqual(["d:1", "d:2", "d:3", "c:9"]);
    expect(edges).toHaveLength(2);
    expect(nodes.find((n) => n.id === "d:1")).toMatchObject({ degree: 2, href: "/orgs/o1/docs/1" });
    expect(nodes.find((n) => n.id === "c:9")).toMatchObject({ degree: 1, href: "/comments/9" });
  });

  it("can leave out comments", () => {
    const { nodes, edges } = buildGraph("o1", graph, tree, { ...all, showComments: false });
    expect(nodes.map((n) => n.id)).toEqual(["d:1", "d:2", "d:3"]);
    expect(edges).toEqual([{ source: "d:1", target: "d:2" }]);
  });

  it("narrows to docs with chosen tags, and the comments linked to them", () => {
    const { nodes } = buildGraph("o1", graph, tree, { ...all, onlyTags: new Set(["web"]) });
    expect(nodes.map((n) => n.id)).toEqual(["d:1", "c:9"]);
  });

  it("adds tags as nodes, in their own style, linked to their docs", () => {
    const { nodes, edges } = buildGraph("o1", graph, tree, { ...all, showTags: true });
    expect(nodes.find((n) => n.id === "t:web")).toMatchObject({
      kind: "tag",
      label: "#web",
      icon: "globe",
      color: "#00f",
    });
    expect(edges).toContainEqual({ source: "d:1", target: "t:web" });
    expect(edges).toContainEqual({ source: "d:3", target: "t:ops" });
  });

  it("lists each node's neighbours, itself included", () => {
    const { nodes, edges } = buildGraph("o1", graph, tree, all);
    const neighbours = neighboursOf(nodes, edges);
    expect([...(neighbours.get("d:1") ?? [])].sort()).toEqual(["c:9", "d:1", "d:2"]);
    expect([...(neighbours.get("d:3") ?? [])]).toEqual(["d:3"]);
  });
});

describe("drawing decisions", () => {
  const node = (overrides: Partial<Node> = {}): Node => ({
    id: "d:1",
    kind: "doc",
    label: "Plan",
    href: null,
    degree: 0,
    icon: "file",
    color: null,
    ...overrides,
  });

  it("sizes docs by how linked they are", () => {
    expect(radius(node({ degree: 0 }))).toBe(10);
    expect(radius(node({ degree: 4 }))).toBeCloseTo(14.8);
    expect(radius(node({ kind: "tag" }))).toBe(9);
    expect(radius(node({ kind: "comment" }))).toBe(8);
  });

  it("shortens long labels", () => {
    expect(shortLabel("short")).toBe("short");
    expect(shortLabel("x".repeat(41))).toBe(`${"x".repeat(40)}…`);
  });

  it("matches the highlight text anywhere in the label", () => {
    expect(matches(node({ label: "Release Plan" }), "plan")).toBe(true);
    expect(matches(node({ label: "Notes" }), "plan")).toBe(false);
    expect(matches(node(), "")).toBe(true);
  });

  it("shows labels for the hovered node, its neighbours, zoomed in, or matching", () => {
    const base = { hovered: false, focus: null, zoom: 0.5, query: "" };
    expect(labelVisible(node(), base)).toBe(false);
    expect(labelVisible(node(), { ...base, hovered: true })).toBe(true);
    expect(labelVisible(node(), { ...base, focus: new Set(["d:1"]) })).toBe(true);
    expect(labelVisible(node(), { ...base, focus: new Set(["d:2"]), zoom: 2 })).toBe(false);
    expect(labelVisible(node(), { ...base, zoom: 1 })).toBe(true);
    expect(labelVisible(node(), { ...base, query: "pla" })).toBe(true);
    expect(labelVisible(node({ kind: "comment" }), { ...base, zoom: 2 })).toBe(false);
  });
});

describe("pointer and zoom", () => {
  it("converts screen points to the world", () => {
    expect(toWorld({ x: 100, y: 50, k: 2 }, { x: 300, y: 250 })).toEqual({ x: 100, y: 100 });
  });

  it("finds the nearest node under the pointer", () => {
    const nodes = [
      { id: "a", kind: "doc", degree: 0, x: 0, y: 0 },
      { id: "b", kind: "doc", degree: 0, x: 15, y: 0 },
    ] as Node[];
    expect(nodeAt(nodes, { x: 9, y: 0 }, 1)?.id).toBe("b");
    expect(nodeAt(nodes, { x: 2, y: 0 }, 1)?.id).toBe("a");
    expect(nodeAt(nodes, { x: 100, y: 100 }, 1)).toBeNull();
  });

  it("zooms about the pointer, within limits", () => {
    const view = { x: 0, y: 0, k: 1 };
    const zoomed = zoomView(view, { x: 100, y: 100 }, -100);
    expect(zoomed.k).toBeGreaterThan(1);
    // The world point under the pointer stays under it.
    expect(toWorld(zoomed, { x: 100, y: 100 }).x).toBeCloseTo(100);
    expect(zoomView(view, { x: 0, y: 0 }, -1e6).k).toBe(MAX_ZOOM);
    expect(zoomView(view, { x: 0, y: 0 }, 1e6).k).toBe(MIN_ZOOM);
  });
});
