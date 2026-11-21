import type { AccessMapNode } from "@inklayer/api";
import { describe, expect, it } from "vitest";
import { layoutAccessMap, NODE_HEIGHT, NODE_WIDTH } from "../src/components/access/accessMapLayout";

/** The item, or a failed test if it's missing. */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing");
  return value;
}

const node = (id: string, column: number, change: AccessMapNode["change"] = null): AccessMapNode => ({
  id,
  kind: column === 2 ? "Product" : column === 1 ? "Team" : "Person",
  column,
  label: id,
  detail: null,
  entityId: null,
  role: null,
  change,
});

describe("access map layout", () => {
  it("puts each column side by side, centred on the tallest", () => {
    const layout = layoutAccessMap({
      nodes: [node("me", 0), node("team", 1), node("a", 2), node("b", 2), node("c", 2)],
      edges: [],
    });
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    const [me, team, a, b] = ["me", "team", "a", "b"].map((id) => must(byId.get(id)));
    const at = { me: must(me), team: must(team), a: must(a), b: must(b) };

    expect(at.me.x).toBe(0);
    expect(at.team.x).toBeGreaterThan(at.me.x + NODE_WIDTH);
    expect(at.a.x).toBeGreaterThan(at.team.x + NODE_WIDTH);
    expect(at.me.y + NODE_HEIGHT / 2).toBeCloseTo(layout.height / 2);
    expect(at.b.y + NODE_HEIGHT / 2).toBeCloseTo(layout.height / 2);
    expect(layout.width).toBe(at.a.x + NODE_WIDTH);
  });

  it("lists what a preview changes first, keeping the order otherwise", () => {
    const layout = layoutAccessMap({
      nodes: [node("a", 2), node("b", 2), node("c", 2, "Added"), node("d", 2)],
      edges: [],
    });
    expect(layout.nodes.map((n) => n.id)).toEqual(["c", "a", "b", "d"]);
  });

  it("draws edges between the sides of the boxes and drops edges to missing nodes", () => {
    const layout = layoutAccessMap({
      nodes: [node("me", 0), node("a", 2)],
      edges: [
        { from: "me", to: "a", role: "Viewer" },
        { from: "me", to: "gone", role: null },
      ],
    });
    expect(layout.edges).toHaveLength(1);
    const edge = must(layout.edges[0]);
    const [me, a] = [must(layout.nodes[0]), must(layout.nodes[1])];
    expect(edge.path.startsWith(`M ${me.x + NODE_WIDTH} ${me.y + NODE_HEIGHT / 2} `)).toBe(true);
    expect(edge.path.endsWith(`${a.x} ${a.y + NODE_HEIGHT / 2}`)).toBe(true);
  });

  it("is empty for an empty map", () => {
    expect(layoutAccessMap({ nodes: [], edges: [] })).toEqual({ nodes: [], edges: [], width: 0, height: 0 });
  });
});
