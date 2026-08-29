// The web-shell flavor of the UI lab (see vite.lab.config.ts): serves
// lab/web.html for every app path so the web router's browser history
// works, on its own port beside the desktop lab.
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { labBaseConfig } from "./vite.lab.base";

// Rewrite document requests to the web entry (vite's default SPA
// fallback only serves index.html, which is the desktop lab's entry).
function webHtmlFallback(): Plugin {
  return {
    name: "lab-web-html-fallback",
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

// Imports of the real web bridge singleton resolve to the lab shim, so
// web/app pages mount on the fixture api (see lab/webInstall.ts).
function labWebInstallAlias(): Plugin {
  return {
    name: "lab-web-install-alias",
    enforce: "pre",
    resolveId(source, importer) {
      if (
        importer !== undefined &&
        importer.includes("/web/") &&
        (source.endsWith("bridge/install") ||
          source.endsWith("../bridge/install"))
      ) {
        return resolve(__dirname, "lab/webInstall.ts");
      }
      return null;
    },
  };
}

const base = labBaseConfig({ port: 5192, entry: "web.html" });

export default defineConfig({
  ...base,
  // The two lab-web plugins first (labWebInstallAlias resolves before
  // anything else anyway), then the shared trio.
  plugins: [labWebInstallAlias(), webHtmlFallback(), ...(base.plugins ?? [])],
});
