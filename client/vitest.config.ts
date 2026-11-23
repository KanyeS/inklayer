import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // As in the extension's build (apps/extension/vite.config.ts).
  resolve: { alias: { "@claude-plugin": path.resolve(import.meta.dirname, "../claude-plugin") } },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "test/**/*.test.ts"],
    environment: "jsdom",
    // Shadow-DOM styles are imported as strings (`./x.css?inline`); load their real text rather than an empty stub.
    css: true,
  },
});
