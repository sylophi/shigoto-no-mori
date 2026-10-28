// The facts of a host with no shell around it. A packaged one is a
// folder holding this bundle beside the binaries it runs (sm, nativefs,
// file-sync, cloudflared) and node-pty, and is its flavor and version as
// it was built. A dev run's bundle is in the app's dist-headless/, so
// the binaries are found in the app's other dist folders, and is dev.
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { appFolders } from "@shigomori/engine/footprint";
import * as Paths from "@shigomori/engine/Paths";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { HostFacts } from "@shared/hostFacts";

export async function headlessFacts(): Promise<HostFacts> {
  const packaged = __SM_HEADLESS_PACKAGED__;
  const flavor = packaged ? __SM_PACKAGED_FLAVOR__ : "dev";
  const paths = await Effect.runPromise(
    Effect.service(Paths.Paths).pipe(
      Effect.provide(
        Paths.layer(flavor).pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );
  const { userData, logs } = appFolders(flavor, paths);
  await mkdir(userData, { recursive: true, mode: 0o700 });
  await mkdir(logs, { recursive: true });
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
