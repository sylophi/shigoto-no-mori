// Vite config for the UI lab (design exploration only, never deployed):
// the DESKTOP renderer tree mounted in a browser over a fixture
// window.api bridge (lab/bridge.ts), so every multi-device surface can
// be posed and screenshotted without a relay, a second machine, or
// Clerk. Mirrors vite.web.config.ts (same plugins, same aliases) with
// three differences: the lab root, a distinct port, and the @clerk/*
// aliases onto the lab's in-memory stub so account UI renders signed-in
// without a network.
import { resolve } from "node:path";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(__dirname, "lab"),
  // Reuse the web client's public dir for the CSP-safe theme boot
  // script the HTML shell references.
  publicDir: resolve(__dirname, "web/public"),
  resolve: {
    alias: {
      "@clerk/electron/react": resolve(__dirname, "lab/clerkStub.tsx"),
      "@clerk/react": resolve(__dirname, "lab/clerkStub.tsx"),
      "@": resolve(__dirname, "renderer"),
      "@shared": resolve(__dirname, "shared"),
    },
  },
  server: { port: 5191, strictPort: true },
  optimizeDeps: { entries: ["index.html"] },
  define: {
    __APP_VERSION__: JSON.stringify("2.0.3"),
    __APP_COMMIT__: JSON.stringify("lab"),
  },
  plugins: [
    tailwindcss(),
    react(),
    babel({ presets: [reactCompilerPreset()] }),
  ],
});
