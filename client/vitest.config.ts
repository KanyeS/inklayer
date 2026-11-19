import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "test/**/*.test.ts"],
    environment: "jsdom",
    // Shadow-DOM styles are imported as strings (`./x.css?inline`); load their real text rather than an empty stub.
    css: true,
  },
});
