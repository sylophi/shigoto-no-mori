import { defineConfig, mergeConfig } from "vite";
import { buildInfoDefine } from "./vite.buildInfo";
import { reactGrabBuild } from "./vite.reactGrab";
import { rendererTreeConfig } from "./vite.rendererTree";
import { rendererDevServerPort } from "./scripts/lib/portsEnvFile.mts";

export default defineConfig(({ mode }) => {
  const envPort = rendererDevServerPort();
  const port = envPort ? Number(envPort) : undefined;

  return mergeConfig(
    // The dep scanner scoped to the real entry. Its default **/*.html
    // glob picks up LICENSES.chromium.html inside out/ packaged builds
    // and fails the scan with noisy (harmless) errors at dev boot.
    rendererTreeConfig({ root: __dirname, entry: "index.html" }),
    {
      // The Electron window loads over the shigomori-dev:// scheme with
      // main proxying http to this server (main/electron/clerk.ts), so
      // the HMR client cannot derive its websocket endpoint from the page
      // location, so pin it to the dev server directly. The pin is
      // unconditional: with no RENDERER_PORT vite picks its own port and
      // injects the resolved one, and losing the pin with the port block
      // would leave a working page with silently dead HMR. `ws` is the
      // current spelling, `hmr.{host,port,…}` is deprecated in vite 8.
      server: {
        ...(port ? { port, strictPort: true } : {}),
        ws: { host: "localhost", protocol: "ws" },
      },
      define: buildInfoDefine(mode),
      build: reactGrabBuild,
    },
  );
});
