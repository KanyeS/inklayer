import { defineConfig } from "vite";

// Paths are relative to this folder (npm runs workspace scripts here).
// Two builds into dist/:
//  - default: the module service worker (background.js) and the popup page
//  - content: the capture script injected into pages, as one self-contained IIFE (content.js),
//    because files injected with chrome.scripting can't use ES module imports
export default defineConfig(({ mode }) =>
  mode === "content"
    ? {
        build: {
          outDir: "dist",
          emptyOutDir: false,
          target: "chrome120",
          lib: {
            entry: "src/content.ts",
            formats: ["iife"],
            name: "InklayerContent",
            fileName: () => "content.js",
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
