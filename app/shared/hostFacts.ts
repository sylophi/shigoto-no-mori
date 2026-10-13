// What the shell hands the host as it starts it (main/hostProcess.ts):
// the app's place, version, folders and page origin, which the host
// reads as its HostFacts service (host/lib/HostFacts.ts).
import * as Schema from "effect/Schema";

export const HostFactsSchema = Schema.Struct({
  packaged: Schema.Boolean,
  // The app's own directory, where a dev build's dist folders are, and
  // Resources/ in a packaged build.
  appPath: Schema.String,
  resourcesPath: Schema.String,
  appVersion: Schema.String,
  // The shell's own data, where the host keeps the files a crash must
  // not orphan (cloudflared.pid).
  userDataPath: Schema.String,
  // The app's log folder, where the host writes its trace file.
  logsPath: Schema.String,
  // The desktop window's page origin, which the loopback admits.
  rendererOrigin: Schema.String,
  // The build's flavor (main/flavor.ts), which names the data dir and
  // the binaries.
  flavor: Schema.Literals(["prod", "v3", "dev"]),
  // The hosts that exited unasked since one was last up, each with when
  // the shell started it, the last a moment before this one: what their
  // scripts left running is this one's to stop (lib/scripts/
  // OrphanSweep.ts). Absent at the app's start.
  replacesHosts: Schema.optional(
    Schema.Array(
      Schema.Struct({ pid: Schema.Number, startedAt: Schema.Number }),
    ),
  ),
});

// The command-line flag the facts ride, as JSON, into the host's
// process.
export const HOST_FACTS_FLAG = "--sm-host-facts=";

export type HostFacts = typeof HostFactsSchema.Type;
