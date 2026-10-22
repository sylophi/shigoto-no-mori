import { push, defineContract, invoke } from "../contract.ts";
import {
  MoveDataDirPayloadSchema,
  NukeProgressSchema,
  NukeReportSchema,
  RuntimeInfoSchema,
  VoidSchema,
} from "../schemas/index.ts";

// Host lifecycle of the shigomori data dir. The client-side calls are
// in the client-scoped modules: theme preview and relaunch on window,
// appearance on clientConfig.
// nuke stays on the loopback (remote false): wiping a machine is
// for whoever sits at it. moveDataDir rides the wire behind the command
// grant, so a peer's Settings page can relocate that device's data
// folder. The host relaunches itself after such a call, since the peer
// has no window module to acknowledge with (host/ipc/modules/runtime).
// info rides the wire so a peer's pages spell this host's paths the
// way the local ones do (its home as ~, where a worktree will land).
// Ungated, under the sharing switch like the lists: their paths and
// worktrees:relocationPlan already show the home and the data dir.
export const runtimeContract = defineContract(
  "runtime",
  "host",
  invoke("info", VoidSchema, RuntimeInfoSchema, {
    remote: true,
    gated: false,
  }),
  // The host's half of a nuke: everything that needs the store or a
  // running host. The files go at the next start (window:nuke).
  invoke("nuke", VoidSchema, NukeReportSchema, { remote: false }),
  invoke("moveDataDir", MoveDataDirPayloadSchema, VoidSchema, {
    remote: true,
    gated: true,
    grant: "changeApp",
  }),
  push("nukeProgress", NukeProgressSchema, {
    remote: true,
  }),
);
