import { resolve } from "node:path";
import { defineConfig } from "vite";

// The showcase at https://inklayer.online, published to GitHub Pages from dist/ (see .github/workflows/pages.yml).
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        privacy: resolve(import.meta.dirname, "privacy.html"),
        notFound: resolve(import.meta.dirname, "404.html"),
      },
    },
  },
});
