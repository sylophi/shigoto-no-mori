// The facts of a host with no shell around it. A packaged one is a
// folder holding this bundle beside the binaries it runs (sm, nativefs,
// file-sync, cloudflared) and node-pty, and is its flavor and version as
// it was built. A dev run's bundle is in the app's dist-headless/, so
// the binaries are found in the app's other dist folders, and is dev.
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { appFolders } from "@shigomori/engine/footprint";
import type { HostFacts } from "@shared/hostFacts";
import { resolvePaths } from "@shared/paths";

export async function headlessFacts(): Promise<HostFacts> {
  const packaged = __SM_HEADLESS_PACKAGED__;
  const flavor = packaged ? __SM_PACKAGED_FLAVOR__ : "dev";
  const { userData, logs } = appFolders(flavor, await resolvePaths(flavor));
  await mkdir(userData, { recursive: true, mode: 0o700 });
  await mkdir(logs, { recursive: true, mode: 0o700 });
  const appPath = packaged ? __dirname : dirname(__dirname);
  return {
    packaged,
    appPath,
    resourcesPath: appPath,
    appVersion: __SM_APP_VERSION__,
    userDataPath: userData,
    logsPath: logs,
    // No window: the loopback admits only callers that send no Origin.
    rendererOrigin: "",
    flavor,
  };
}
