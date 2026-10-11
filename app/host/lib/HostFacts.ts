// What the host knows of the app it serves: handed over once, as it
// starts, by the shell that started it (main/hostProcess.ts). The host
// asks Electron nothing, so its version, where its binaries are and the
// page origin its loopback admits all come from here.
import * as Context from "effect/Context";
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
  flavor: Schema.Literals(["prod", "test", "dev"]),
});

// The command-line flag the facts ride, as JSON, into the host's
// process.
export const HOST_FACTS_FLAG = "--sm-host-facts=";

export class HostFacts extends Context.Service<
  HostFacts,
  typeof HostFactsSchema.Type
>()("sm/host/HostFacts") {}
