// Vite config for the fake host (design exploration only, never
// deployed): the DESKTOP renderer tree mounted in a browser over a
// fixture window.api bridge (bridge.ts), so every
// multi-device surface can be posed and screenshotted without a device
// hub, a second machine, or Clerk. Mirrors the app-root
// vite.web.config.ts (same plugins, same aliases) with three
// differences: the fake host root, a distinct port, and the @clerk/*
// aliases onto the fake host's in-memory stub so account UI renders
// signed-in without a network. Those shared pieces live in
// vite.base.ts, which the web-shell flavor builds on too.
import { defineConfig } from "vite";
import { fakeHostBaseConfig } from "./vite.base";

export default defineConfig(
  fakeHostBaseConfig({ portKey: "FAKE_HOST_PORT", entry: "index.html" }),
);
