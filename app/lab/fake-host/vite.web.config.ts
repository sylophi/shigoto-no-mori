// The web-shell flavor of the fake host (see vite.config.ts): serves
// web.html for every app path so the web router's
// browser history works, on its own port beside the desktop fake host.
import { defineConfig, type Plugin } from "vite";
import { fakeHostBaseConfig } from "./vite.base";

// Rewrite document requests to the web entry (vite's default SPA
// fallback only serves index.html, which is the desktop fake host's entry).
function webHtmlFallback(): Plugin {
  return {
    name: "fake-host-web-html-fallback",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const url = req.url ?? "/";
        const [pathname, search] = url.split("?");
        const wantsDocument =
          req.headers.accept?.includes("text/html") === true;
        if (
          wantsDocument &&
          pathname !== undefined &&
          !pathname.includes(".")
        ) {
          req.url = `/web.html${search !== undefined ? `?${search}` : ""}`;
        }
        next();
      });
    },
  };
}

const base = fakeHostBaseConfig({
  portKey: "FAKE_HOST_WEB_PORT",
  entry: "web.html",
});

export default defineConfig({
  ...base,
  plugins: [webHtmlFallback(), ...(base.plugins ?? [])],
});
