import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * Notices for bundled code under a licence that requires them. elkjs (mermaid's diagram layout engine) is used under
 * EPL-2.0, unmodified: its licence and where to get its source ship with the app as /third-party-notices.txt.
 */
function thirdPartyNotices(): Plugin {
  const require = createRequire(import.meta.url);
  return {
    name: "inklayer-third-party-notices",
    generateBundle() {
      const pkg = require("elkjs/package.json") as { version: string };
      const licence = readFileSync(require.resolve("elkjs/LICENSE.md"), "utf8");
      this.emitFile({
        type: "asset",
        fileName: "third-party-notices.txt",
        source: [
          "Inklayer is licensed under Apache-2.0. It includes the following third-party software under other terms.",
          "",
          `elkjs ${pkg.version} (Eclipse Layout Kernel for JavaScript), used by mermaid to lay out diagrams.`,
          "Copyright (c) Kiel University and others. Used unmodified, under the Eclipse Public License 2.0",
          "(elkjs is offered under EPL-2.0 or GPL-3.0-or-later; Inklayer uses it under EPL-2.0).",
          "Source code: https://github.com/kieler/elkjs",
          "",
          licence,
        ].join("\n"),
      });
    },
  };
}

// Builds into the server's web root. The server serves it on the app origin, with an index.html fallback for client routes.
export default defineConfig({
  plugins: [react(), tailwindcss(), thirdPartyNotices()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  build: {
    outDir: "../../../server/src/Inklayer.Api/wwwroot",
    emptyOutDir: true,
    target: "es2022",
  },
});
