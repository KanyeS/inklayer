import { describe, expect, it } from "vitest";
import { findRoute, match, type Route } from "../src/lib/router";

describe("matching addresses", () => {
  it("reads :params, decoded", () => {
    expect(match("/orgs/:orgId/docs/:docId", "/orgs/a%20b/docs/42")).toEqual({ orgId: "a b", docId: "42" });
  });

  it("needs the same number of parts", () => {
    expect(match("/orgs/:orgId", "/orgs/1/docs")).toBeNull();
    expect(match("/orgs/:orgId/docs", "/orgs/1")).toBeNull();
  });

  it("ignores a trailing slash", () => {
    expect(match("/pages", "/pages/")).toEqual({});
  });
});

describe("finding the page for an address", () => {
  const routes: Route<string>[] = [
    { pattern: "/", page: "home" },
    { pattern: "/orgs/:orgId", page: "org" },
    { pattern: "/orgs/:orgId/docs", page: "docs", enabled: () => false },
  ];

  it("matches the home page with or without a slash", () => {
    expect(findRoute(routes, "/")?.route.page).toBe("home");
    expect(findRoute(routes, "")?.route.page).toBe("home");
  });

  it("returns the route and its params", () => {
    const found = findRoute(routes, "/orgs/7/");
    expect(found?.route.page).toBe("org");
    expect(found?.params).toEqual({ orgId: "7" });
  });

  it("still finds a turned-off page, so the app can say it's off", () => {
    expect(findRoute(routes, "/orgs/7/docs")?.route.enabled?.()).toBe(false);
  });

  it("finds nothing for an unknown address", () => {
    expect(findRoute(routes, "/nope")).toBeNull();
  });
});
