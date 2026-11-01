// Vite config for the fake host (design exploration only, never
// deployed): the DESKTOP renderer tree mounted in a browser over a
// fixture page api (bridge.ts), so every
// multi-device surface can be posed and screenshotted without a device
// hub, a second machine, or Clerk. Built on vite.base.ts, which the
// web-shell flavor builds on too.
import { defineConfig } from "vite";
import { fakeHostBaseConfig } from "./vite.base";

export default defineConfig(
  fakeHostBaseConfig({ portKey: "FAKE_HOST_PORT", entry: "index.html" }),
);
