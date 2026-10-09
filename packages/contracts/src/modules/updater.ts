import { broadcast, defineContract, invoke } from "../contract.ts";
import { UpdaterStateSchema, VoidSchema } from "../schemas/index.ts";

// The app updater, as a HOST module: the update is a fact about the
// machine the app runs on, and the Settings page shows every device
// of the account, so a peer reads this device's update state and may
// start a check or a restart-to-update from there. Reads are served
// to any account peer. The commands ride the per-peer command
// grant like every other mutation. The state rides its own broadcast.
export const updaterContract = defineContract(
  "updater",
  "host",
  invoke("get", VoidSchema, UpdaterStateSchema, {
    remote: true,
    gated: false,
  }),
  invoke("check", VoidSchema, VoidSchema, {
    remote: true,
    gated: true,
    grant: "changeApp",
  }),
  invoke("install", VoidSchema, VoidSchema, {
    remote: true,
    gated: true,
    grant: "changeApp",
  }),
  // Install the staged update, or fetch one first and install it once
  // it is staged (Update all, for a device that hasn't found the
  // release yet). Answers once the install started or was armed.
  invoke("update", VoidSchema, VoidSchema, {
    remote: true,
    gated: true,
    grant: "changeApp",
  }),
  broadcast("state", UpdaterStateSchema, { remote: true }),
);
