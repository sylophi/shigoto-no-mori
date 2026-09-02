// Vite config for the UI lab (design exploration only, never deployed):
// the DESKTOP renderer tree mounted in a browser over a fixture
// window.api bridge (lab/bridge.ts), so every multi-device surface can
// be posed and screenshotted without a device hub, a second machine, or
// Clerk. Mirrors vite.web.config.ts (same plugins, same aliases) with
// three differences: the lab root, a distinct port, and the @clerk/*
// aliases onto the lab's in-memory stub so account UI renders signed-in
// without a network. Those shared pieces live in vite.lab.base.ts,
// which the web-shell flavor builds on too.
import { defineConfig } from "vite";
import { labBaseConfig } from "./vite.lab.base";

export default defineConfig(labBaseConfig({ port: 5191, entry: "index.html" }));
