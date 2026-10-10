// What the host knows of the app it serves: handed over once, as it
// starts, by the shell that started it (main/hostProcess.ts). The host
// asks Electron nothing, so its version, where
// its binaries are and the page origin its loopback admits all come
// from here.
import * as Schema from "effect/Schema";
import {
  bundledBinaryPath,
  bundledBinaryResolver,
} from "@shared/packaging/bundledBinary.mts";
import { implSlot } from "@host/lib/util/implSlot";

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
});
export type HostFacts = typeof HostFactsSchema.Type;

// The command-line flag the facts ride, as JSON, into the host's
// process.
export const HOST_FACTS_FLAG = "--sm-host-facts=";

const { set: setHostFacts, get: hostFacts } = implSlot<HostFacts>(
  "the host was asked a fact before its shell handed them over",
);
export { hostFacts, setHostFacts };

// The build flavor, which names the data dir and the binaries.
export const flavorOf = (facts: HostFacts): "prod" | "dev" =>
  facts.packaged ? "prod" : "dev";

export const hostBinaryPath = (devDistDir: string, name: string): string =>
  bundledBinaryPath(hostFacts(), devDistDir, name);

export const hostBinaryResolver = (
  devDistDir: string,
  name: () => string,
): (() => string | null) => bundledBinaryResolver(hostFacts, devDistDir, name);
