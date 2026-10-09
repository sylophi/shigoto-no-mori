// What the host knows of the app it serves: handed over once, as it
// starts, by the shell that started it (main/hostProcess.ts). The host
// asks Electron nothing (decision 6 of V3.md), so its version, where
// its binaries are and the page origin its loopback admits all come
// from here.
import {
  type AppPlace,
  bundledBinaryPath,
  bundledBinaryResolver,
} from "@shared/packaging/bundledBinary.mts";
import { implSlot } from "@host/lib/util/implSlot";

export type HostFacts = AppPlace & {
  readonly appVersion: string;
  // The shell's own data, where the host keeps the files a crash must
  // not orphan (cloudflared.pid).
  readonly userDataPath: string;
  // The desktop window's page origin, which the loopback admits.
  readonly rendererOrigin: string;
};

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
