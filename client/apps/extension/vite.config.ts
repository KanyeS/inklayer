import { defineConfig } from "vite";

// Paths are relative to this folder (npm runs workspace scripts here).
// Three builds into dist/:
//  - default: the module service worker (background.js) and the popup page
//  - content: the capture script injected into pages, as one self-contained IIFE (content.js),
//    because files injected with chrome.scripting can't use ES module imports
//  - live: the live-mode script registered for a project's live sites, also one self-contained IIFE (live.js)
const SCRIPTS: Record<string, { entry: string; name: string; file: string }> = {
  content: { entry: "src/content.ts", name: "InklayerContent", file: "content.js" },
  live: { entry: "src/live-page.ts", name: "InklayerLive", file: "live.js" },
};

export default defineConfig(({ mode }) =>
  SCRIPTS[mode]
    ? {
        build: {
          outDir: "dist",
          emptyOutDir: false,
          target: "chrome120",
          lib: {
            entry: SCRIPTS[mode].entry,
            formats: ["iife"],
            name: SCRIPTS[mode].name,
            fileName: () => SCRIPTS[mode].file,
          },
        },
      }
    : {
        publicDir: "public",
        build: {
          outDir: "dist",
          emptyOutDir: true,
          target: "chrome120",
          modulePreload: false,
          rollupOptions: {
            input: {
              background: "src/background.ts",
              popup: "popup.html",
            },
            output: {
              entryFileNames: "[name].js",
              chunkFileNames: "chunks/[name]-[hash].js",
              assetFileNames: "assets/[name]-[hash][extname]",
            },
          },
        },
      },
);
