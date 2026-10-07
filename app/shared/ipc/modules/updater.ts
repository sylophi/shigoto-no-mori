import { z } from "zod";
import { broadcast, defineContract, invoke } from "@shared/ipc/contract";
import { UpdaterStateSchema, VoidSchema } from "@shared/schemas";

// The app updater, as a HOST module: the update is a fact about the
// machine the app runs on, and the Settings page shows every device
// of the account, so a peer reads this device's update state and may
// start a check or a restart-to-update from there. Reads are served
// to any account peer. The commands ride the per-peer command
// grant like every other mutation. No command moves any host
// state a viewer caches (the state rides its own broadcast), so they
// opt out of the resolved-mutation cache ping.
export const updaterContract = defineContract("host", {
  get: invoke("updater:get", VoidSchema, UpdaterStateSchema, {
    remote: true,
    gated: false,
  }),
  check: invoke("updater:check", z.void(), z.void(), {
    remote: true,
    gated: true,
    movesHostState: false,
  }),
  install: invoke("updater:install", z.void(), z.void(), {
    remote: true,
    gated: true,
    movesHostState: false,
  }),
  // Install the staged update, or fetch one first and install it once
  // it is staged (Update all, for a device that hasn't found the
  // release yet). Answers once the install started or was armed.
  update: invoke("updater:update", z.void(), z.void(), {
    remote: true,
    gated: true,
    movesHostState: false,
  }),
  state: broadcast("updater:state", UpdaterStateSchema, { remote: true }),
});
