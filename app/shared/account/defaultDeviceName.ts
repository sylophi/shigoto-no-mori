// The name a machine enrolls under before anyone renames it: what its
// owner already calls it, as far as the OS will say. Pure node (os and
// a child process), for the desktop shell and the headless host.
import { hostname } from "node:os";
import { current as currentPlatform } from "@shigomori/engine/platform";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// The hostname's first DNS label. macOS reports the mDNS form
// ("Name.local") and a domain-joined box reports "name.corp.example",
// and neither suffix is anything a person calls the machine. A name
// that would strip to nothing comes back whole, so the default can
// never blank.
function shortHostname(host: string): string {
  const short = host.split(".")[0] ?? "";
  return short === "" ? host : short;
}

export type DefaultDeviceName = {
  name: string;
  // True when the OS's own answer could not be read this time (macOS
  // without a scutil answer) and the hostname is standing in. A caller
  // that PERSISTS the default waits for a settled one, so a slow boot
  // cannot bake the stand-in into the stored name for good.
  provisional: boolean;
};

// macOS keeps the name a person gave the machine ("Rin's MacBook Pro")
// apart from the hostname it derives from it ("Rins-MacBook-Pro.local"),
// and only scutil reads the former. Null off macOS or when it cannot be
// read (no scutil, an empty name). Async so the main process never
// blocks on the child, and bounded so a wedged scutil cannot hang the
// caller.
async function macComputerName(): Promise<string | null> {
  try {
    const { stdout } = await execFileP(
      "/usr/sbin/scutil",
      ["--get", "ComputerName"],
      { timeout: 2000 },
    );
    const name = stdout.trim();
    return name === "" ? null : name;
  } catch {
    return null;
  }
}

export async function defaultDesktopDeviceName(): Promise<DefaultDeviceName> {
  const fallback = { name: shortHostname(hostname()), provisional: false };
  if (currentPlatform() !== "darwin") return fallback;
  const computerName = await macComputerName();
  return computerName === null
    ? { ...fallback, provisional: true }
    : { name: computerName, provisional: false };
}
