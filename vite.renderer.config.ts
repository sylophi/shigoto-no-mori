import { resolve } from "node:path";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const port = env["PORT"] ? Number(env["PORT"]) : undefined;

  return {
    resolve: {
      alias: {
        "@": resolve(__dirname, "src"),
        "@shared": resolve(__dirname, "src/shared"),
      },
    },
    server: port ? { port, strictPort: true } : undefined,
    plugins: [
      tailwindcss(),
      react(),
      // @vitejs/plugin-react v6 dropped its inline babel option (it
      // switched to Oxc for Fast Refresh), so the React Compiler ships
      // via @rolldown/plugin-babel using the canonical preset exported
      // by the react plugin itself.
      babel({ presets: [reactCompilerPreset()] }),
    ],
    build: {
      // Keep material-icon-theme SVGs as separate hashed files so each one
      // loads on-demand when its icon is actually displayed. Inlined as
      // base64 they'd bloat the JS bundle for icons that may never render.
      assetsInlineLimit: (filePath) => {
        if (filePath.includes("material-icon-theme/icons/")) return false;
        return undefined;
      },
    },
  };
});
