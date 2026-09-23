// The shape of window.api, which every shell installs before any
// renderer module evaluates: the desktop from the preload's bridge
// (renderer/electronApi.ts), the browser from the web bridge
// (web/preload.ts), the lab from its fixture wire. One type here so
// the three cannot drift from each other or from buildApi.
import type { buildApi } from "./client";

export type RendererFacts = {
  readonly deviceId: string;
  readonly appVersion: string;
  // The Clerk publishable key the binding resolved. Empty on an
  // unconfigured build, which the renderer reads as "mount no
  // ClerkProvider".
  readonly clerkPublishableKey: string;
  // Dev-only affordances key off the build showing the window, never
  // the host (a packaged client on a dev host must not grow dev
  // hotkeys).
  readonly isDev: boolean;
  // App-only UI (the port-forward controls, which need a real local
  // TCP listener) gates its mount on it, since the shared pages render
  // on both shells and cannot tell the bindings apart otherwise.
  readonly isElectron: boolean;
};

export type RendererApi = RendererFacts & ReturnType<typeof buildApi>;
