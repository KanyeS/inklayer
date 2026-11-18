import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Paths are relative to this folder (npm runs workspace scripts here).
// Two builds into dist/:
//  - default: the module service worker (background.js) and the popup page (React + the shared shadcn theme)
//  - live: the script that shows comments on pages, as one self-contained IIFE (live.js), because content scripts
//    registered with chrome.scripting can't use ES module imports
const SCRIPTS: Record<string, { entry: string; name: string; file: string }> = {
  live: { entry: "src/live-page.ts", name: "InklayerLive", file: "live.js" },
};

const resolve = { alias: { "@": path.resolve(import.meta.dirname, "src") } };

export default defineConfig(({ mode }) =>
  SCRIPTS[mode]
    ? {
        resolve,
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
        plugins: [react(), tailwindcss()],
        resolve,
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
