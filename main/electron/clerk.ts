// The desktop half of Clerk auth: the main-process bridge the Clerk
// renderer SDK talks to over IPC (token storage in userData encrypted
// via safeStorage, and the system-browser OAuth transport with its
// deep-link callback), plus the custom scheme that gives the renderer a
// stable origin. Clerk needs that origin three times over: clerk-js
// refuses the null origin of a file:// document, the OAuth redirect URL
// the system browser calls back is `<scheme>://<host>/...` (routed to
// the app through the scheme registration the bridge performs), and
// the SDK authenticates FAPI calls with an Authorization header, which
// Clerk's API refuses to combine with a browser-set Origin header — a
// custom-scheme page sends no Origin, an http one always does. Both
// modes therefore load the renderer over the scheme: packaged serves
// the built bundle from disk, dev proxies to the vite server (whose
// HMR socket the client dials directly, see vite.renderer.config.ts).
import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, net, protocol } from "electron";
import { createClerkBridge } from "@clerk/electron";
import { storage } from "@clerk/electron/storage";

export const RENDERER_SCHEME_HOST = "app";

// Separate dev and prod schemes, mirroring the dev userData split in
// main/index.ts: both builds register their scheme with the OS, and a
// shared spelling would let an installed copy swallow a dev build's
// OAuth callbacks (or vice versa).
export function rendererScheme(): string {
  return app.isPackaged ? "shigomori" : "shigomori-dev";
}

export function rendererSchemeUrl(): string {
  return `${rendererScheme()}://${RENDERER_SCHEME_HOST}/`;
}

// Must be called before app "ready" (createClerkBridge registers the
// scheme's privileges, which Electron only accepts pre-ready) and after
// the dev userData suffix is applied (token storage lives in userData).
// The app owns the single-instance lock (main/index.ts), so the
// bridge's own lock management is disabled; its open-url and
// second-instance listeners still receive the OAuth deep links.
export function createDesktopClerkBridge(): { cleanup: () => void } {
  return createClerkBridge({
    storage: storage(),
    renderer: { scheme: rendererScheme(), host: RENDERER_SCHEME_HOST },
    manageSingleInstanceLock: false,
  });
}

// Serves the renderer over the scheme origin: the packaged bundle from
// disk, or a proxy onto the vite dev server. Must run after "ready"
// (protocol.handle) and before the window's loadURL.
export function serveRendererOverScheme(
  target: { rendererDir: string } | { devServerUrl: string },
): void {
  protocol.handle(rendererScheme(), (request) => {
    const url = new URL(request.url);
    if (url.host !== RENDERER_SCHEME_HOST) {
      return new Response(null, { status: 404 });
    }
    if ("devServerUrl" in target) {
      const proxied = new URL(url.pathname + url.search, target.devServerUrl);
      const headers = new Headers(request.headers);
      // The dev server sees a plain same-origin-looking request; a
      // scheme Origin or Host would only trip vite's host checks.
      for (const name of ["host", "origin", "referer"]) headers.delete(name);
      return net.fetch(proxied.toString(), {
        method: request.method,
        headers,
        ...(request.body === null
          ? {}
          : { body: request.body, duplex: "half" as const }),
      });
    }
    const pathname = decodeURIComponent(url.pathname);
    const file = path.join(
      target.rendererDir,
      pathname === "/" ? "index.html" : pathname.slice(1),
    );
    // Containment: a crafted ../ path must not escape the bundle dir.
    const relative = path.relative(target.rendererDir, file);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return new Response(null, { status: 404 });
    }
    return net.fetch(pathToFileURL(file).toString());
  });
}
