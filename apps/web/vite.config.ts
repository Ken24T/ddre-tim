import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const configDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(configDirectory, "../..");

export default defineConfig({
  plugins: [react()],
  server: {
    fs: {
      allow: [workspaceRoot]
    },
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/health": {
        target: "http://localhost:4000",
        changeOrigin: true
      },
      "/v1": {
        target: "http://localhost:4000",
        changeOrigin: true
      }
    }
  },
  preview: {
    host: "0.0.0.0",
    port: 4173
  }
});