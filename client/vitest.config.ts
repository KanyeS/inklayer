import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // As in the extension's build (apps/extension/vite.config.ts).
  resolve: { alias: { "@claude-plugin": path.resolve(import.meta.dirname, "../claude-plugin") } },
  plugins: [
    {
      // "@/..." is each app's own src/ (apps/viewer/vite.config.ts, apps/extension/vite.config.ts), so it depends on who imports it.
      name: "app-src-alias",
      enforce: "pre",
      resolveId(source, importer) {
        const app =
          source.startsWith("@/") && importer ? /[/\\]apps[/\\]([^/\\]+)[/\\]/.exec(importer)?.[1] : undefined;
        if (!app) return null;
        return this.resolve(path.resolve(import.meta.dirname, "apps", app, "src", source.slice(2)), importer, {
          skipSelf: true,
        });
      },
    },
  ],
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "test/**/*.test.ts"],
    environment: "jsdom",
    // Shadow-DOM styles are imported as strings (`./x.css?inline`); load their real text rather than an empty stub.
    css: true,
  },
});
