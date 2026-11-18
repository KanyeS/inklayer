import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Builds into the server's web root. The server serves it on the app origin, with an index.html fallback for client routes.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../../../server/src/Inklayer.Api/wwwroot",
    emptyOutDir: true,
    target: "es2022",
  },
});
