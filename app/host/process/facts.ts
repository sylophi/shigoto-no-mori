// The root's facts, given by the entry that started the host before
// anything reads them: the Electron shell's utility process reads them
// off its command line (host.ts), the headless shell knows its own
// (headless/facts.ts). Everything below the root reads them as the
// HostFacts service (lib/HostFacts.ts), which the root provides from
// these.
import { join } from "node:path";
import { bundledBinaryPath } from "@shared/packaging/bundledBinary.mts";
import type { HostFacts } from "@shared/hostFacts";

let given: HostFacts | undefined;

export function setHostFacts(facts: HostFacts): void {
  given = facts;
}

export function hostFacts(): HostFacts {
  if (given === undefined) {
    throw new Error("the host was started without facts");
  }
  return given;
}

export const hostBinaryPath = (devDistDir: string, name: string): string =>
  bundledBinaryPath(hostFacts(), devDistDir, name);

// The live cloudflared's pid (direct/Tunnel.ts), in the shell's own data
// so it outlives the host that wrote it.
export const tunnelPidFile = (): string =>
  join(hostFacts().userDataPath, "cloudflared.pid");
