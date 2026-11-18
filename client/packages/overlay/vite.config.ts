import { defineConfig } from "vite";

// Builds the script the server injects into captured pages (with a CSP nonce) as one classic IIFE file.
// Output goes straight into the server's web root, served at /_inklayer/overlay.js on the snapshot origin.
export default defineConfig({
  build: {
    outDir: "../../../server/src/Inklayer.Api/wwwroot/_inklayer",
    emptyOutDir: true,
    target: "es2022",
    lib: {
      entry: "src/main.ts",
      formats: ["iife"],
      name: "InklayerOverlay",
      fileName: () => "overlay.js",
    },
  },
});
