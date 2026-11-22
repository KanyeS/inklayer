import { defineConfig } from "vite";

// Paths are relative to this folder (pnpm runs workspace scripts here). Two builds into dist/:
//  - page: the script put into every page the browser opens (page.js), one self-contained IIFE. It describes elements
//    the way the extension does (the overlay package's anchors), so comments made here land where people expect.
//  - default: the MCP server itself (server.mjs), for Node. Playwright stays an ordinary dependency.
export default defineConfig(({ mode }) =>
  mode === "page"
    ? {
        build: {
          outDir: "dist",
          emptyOutDir: false,
          target: "chrome120",
          lib: { entry: "src/page/main.ts", formats: ["iife"], name: "InklayerReviewPage", fileName: () => "page.js" },
        },
      }
    : {
        build: {
          outDir: "dist",
          emptyOutDir: false,
          target: "node22",
          ssr: "src/main.ts",
          rollupOptions: { output: { entryFileNames: "server.mjs" } },
        },
        ssr: { noExternal: ["@inklayer/overlay"], external: ["playwright-core"] },
      },
);
