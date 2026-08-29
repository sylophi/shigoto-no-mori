// Everything the two UI lab flavors share (vite.lab.config.ts for the
// desktop renderer tree, vite.weblab.config.ts for the web shell),
// parameterized by the two things that actually differ. Its own module
// rather than a named export beside a default one, which vite's config
// bundler warns about.
import { resolve } from "node:path";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import type { UserConfig } from "vite";

export function labBaseConfig(opts: {
  port: number;
  // The HTML entry vite pre-bundles deps from: the desktop lab's
  // index.html, the web shell's web.html.
  entry: string;
}): UserConfig {
  return {
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
    server: { port: opts.port, strictPort: true },
    optimizeDeps: { entries: [opts.entry] },
    define: {
      __APP_VERSION__: JSON.stringify("2.0.3"),
      __APP_COMMIT__: JSON.stringify("lab"),
    },
    plugins: [
      tailwindcss(),
      react(),
      babel({ presets: [reactCompilerPreset()] }),
    ],
  };
}
