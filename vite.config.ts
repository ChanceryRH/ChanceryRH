import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  base: "/app/",
  publicDir: "web/public",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5180,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:3080",
      "/health": "http://127.0.0.1:3080",
      "/ready": "http://127.0.0.1:3080",
    },
  },
  build: { outDir: "build/app", sourcemap: false },
});
