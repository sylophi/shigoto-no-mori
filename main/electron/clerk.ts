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
import type { TokenStorage } from "@clerk/electron";
import {
  RENDERER_SCHEME_HOST,
  rendererSchemeName,
  rendererSchemeOrigin,
} from "@shared/rendererScheme.mts";

function rendererScheme(): string {
  return rendererSchemeName(app.isPackaged ? "prod" : "dev");
}

export function rendererSchemeUrl(): string {
  return `${rendererSchemeOrigin(app.isPackaged ? "prod" : "dev")}/`;
}

// The SDK's electron-store adapter reads and decrypts the token file on
// EVERY getItem: a synchronous file read plus an OS keychain call, at
// construction and then on each of clerk-js's periodic session
// refreshes. Wrap it so construction moves off the boot path to the
// first token access, and reads after the first are answered from
// memory — main is the sole writer, so the cache can never be stale.
function lazyMemoizedTokenStorage(): TokenStorage {
  let backing: TokenStorage | null = null;
  const cache = new Map<string, string | null>();
  const store = () => (backing ??= storage());
  return {
    getItem: async (key) => {
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      const value = await store().getItem(key);
      cache.set(key, value);
      return value;
    },
    setItem: async (key, value) => {
      await store().setItem(key, value);
      cache.set(key, value);
    },
    removeItem: async (key) => {
      await store().removeItem(key);
      cache.set(key, null);
    },
  };
}

// Must be called before app "ready" (createClerkBridge registers the
// scheme's privileges, which Electron only accepts pre-ready) and after
// the dev userData suffix is applied (token storage lives in userData).
// The app owns the single-instance lock (main/index.ts), so the
// bridge's own lock management is disabled; its open-url and
// second-instance listeners still receive the OAuth deep links.
export function createDesktopClerkBridge(): { cleanup: () => void } {
  return createClerkBridge({
    storage: lazyMemoizedTokenStorage(),
    renderer: { scheme: rendererScheme(), host: RENDERER_SCHEME_HOST },
    manageSingleInstanceLock: false,
  });
}

type SchemeHandler = (request: Request) => Response | Promise<Response>;

// Guards the host before delegating, so both handlers below serve only
// the renderer origin.
function forRendererHost(serve: (url: URL) => Response | Promise<Response>) {
  return (request: Request) => {
    const url = new URL(request.url);
    if (url.host !== RENDERER_SCHEME_HOST) {
      return new Response(null, { status: 404 });
    }
    return serve(url);
  };
}

function proxyHandler(devServerUrl: string): SchemeHandler {
  return forRendererHost((url) => {
    const target = new URL(url.pathname + url.search, devServerUrl);
    return net.fetch(target.toString());
  });
}

function fileHandler(rendererDir: string): SchemeHandler {
  const rootWithSep = path.resolve(rendererDir) + path.sep;
  return forRendererHost((url) => {
    const pathname = decodeURIComponent(url.pathname);
    const file = path.resolve(
      rootWithSep,
      pathname === "/" ? "index.html" : `.${pathname}`,
    );
    // Containment: a crafted ../ path must not escape the bundle dir.
    if (!file.startsWith(rootWithSep)) {
      return new Response(null, { status: 404 });
    }
    return net.fetch(pathToFileURL(file).toString());
  });
}

// Serves the renderer over the scheme origin: the packaged bundle from
// disk, or a proxy onto the vite dev server. Must run after "ready"
// (protocol.handle) and before the window's loadURL. The mode is fixed
// for the process lifetime, so the branch resolves here, not per
// request.
export function serveRendererOverScheme(
  target: { rendererDir: string } | { devServerUrl: string },
): void {
  protocol.handle(
    rendererScheme(),
    "devServerUrl" in target
      ? proxyHandler(target.devServerUrl)
      : fileHandler(target.rendererDir),
  );
}
