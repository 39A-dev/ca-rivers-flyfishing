import { defineConfig } from "vite";

// @arcgis/core ships ESM + assets. Vite serves them fine in dev; for production
// the assets are copied automatically by the SDK's asset loader from the CDN
// unless you self-host (see setAssetPath in src/main.js).
export default defineConfig({
  base: "./",
  build: {
    chunkSizeWarningLimit: 4000, // the SDK is large; silence the noise
  },
});
