import { describe, expect, it } from "vitest";
import { MAX_SITES, rememberSiteProducts, siteProductsFor } from "../src/lib/site-products";

const visible = [{ id: "p1" }, { id: "p2" }];

describe("the products shown per site", () => {
  it("are the ones picked for that site that are still visible", () => {
    const stored = { "https://a.test": ["p2", "gone", "p1"], "https://b.test": ["gone"] };
    expect(siteProductsFor(stored, "https://a.test", visible)).toEqual(["p2", "p1"]);
    expect(siteProductsFor(stored, "https://b.test", visible)).toEqual([]);
    expect(siteProductsFor(stored, "https://c.test", visible)).toEqual([]);
    expect(siteProductsFor(stored, null, visible)).toEqual([]);
  });

  it("reads one product saved by the single-choice menu", () => {
    expect(siteProductsFor({ "https://a.test": "p1" }, "https://a.test", visible)).toEqual(["p1"]);
  });

  it("survives junk in storage", () => {
    expect(siteProductsFor(undefined, "https://a.test", visible)).toEqual([]);
    expect(siteProductsFor(["p1"], "https://a.test", visible)).toEqual([]);
    expect(siteProductsFor({ "https://a.test": 5 }, "https://a.test", visible)).toEqual([]);
    expect(siteProductsFor({ "https://a.test": [5, "p1"] }, "https://a.test", visible)).toEqual(["p1"]);
  });

  it("remembers the latest pick last, and forgets a site set back to all products", () => {
    let stored = rememberSiteProducts({}, "https://a.test", ["p1"]);
    stored = rememberSiteProducts(stored, "https://b.test", ["p2"]);
    stored = rememberSiteProducts(stored, "https://a.test", ["p1", "p2", "p1"]);
    expect(Object.entries(stored)).toEqual([
      ["https://b.test", ["p2"]],
      ["https://a.test", ["p1", "p2"]],
    ]);
    expect(rememberSiteProducts(stored, "https://a.test", [])).toEqual({ "https://b.test": ["p2"] });
  });

  it("keeps only the most recent sites", () => {
    let stored = {};
    for (let i = 0; i <= MAX_SITES; i++) stored = rememberSiteProducts(stored, `https://s${i}.test`, ["p1"]);
    expect(Object.keys(stored)).toHaveLength(MAX_SITES);
    expect(stored).not.toHaveProperty("https://s0.test");
    expect(stored).toHaveProperty(`https://s${MAX_SITES}.test`);
  });
});
