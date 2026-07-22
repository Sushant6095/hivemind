import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// SPA build — Base44 hosting serves static SPAs (no SSR).
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", sourcemap: false },
});
