import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "ScopeWalk",
        short_name: "ScopeWalk",
        description: "Contractor field scope & bid tool",
        display: "standalone",
        orientation: "any",
        background_color: "#111418",
        theme_color: "#111418",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" }
        ]
      },
      workbox: {
        // Offline-first (Hard Rule 2): precache the app shell; API calls are
        // handled by the local-store layer in Phase 1, not the service worker.
        globPatterns: ["**/*.{js,css,html,png,svg,woff2}"]
      }
    })
  ],
  server: {
    proxy: {
      "/api": "http://localhost:8787",
      // Public proposal links (server-rendered customer pages, §9).
      "/p": "http://localhost:8787"
    }
  },
  preview: {
    proxy: {
      "/api": "http://localhost:8787",
      "/p": "http://localhost:8787"
    }
  }
});
