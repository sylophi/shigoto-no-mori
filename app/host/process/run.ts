// The host's run, whichever shell started it: the Electron shell's
// utility process (host.ts) or the headless shell of a machine with no
// windows (headless/main.ts). The entry gives the facts, the Shell
// service over itself, and what it does once the host is up or could
// not come up. The host serves its windows, its shell and the terminal
// on the loopback, and its peers on the device link, until it is asked
// to stop (quit).
import { closeSync, openSync, renameSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { isTestFlavor } from "@shigomori/engine/flavor";
import { childDefaults } from "@shigomori/engine/processes";
import type { HostFailureSchema } from "@shigomori/contracts/modules/shellCalls";
import type { MigrationProgress } from "@shigomori/contracts/schemas/migration";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { errorWordsOf } from "@host/lib/errorWords";
import type { HostFacts as Facts } from "@shared/hostFacts";
import { log } from "@shared/log";
import { CLI_DIST_DIR, cliBinaryName } from "@shared/packaging/cliDist.mts";
import {
  NATIVEFS_BINARY_NAME,
  NATIVEFS_DIST_DIR,
} from "@shared/packaging/nativefsDist.mts";
import * as Migration from "@shigomori/engine/Migration";
import * as DeviceId from "@host/lib/config/DeviceId";
import * as HostFacts from "@host/lib/HostFacts";
import type * as Shell from "@host/lib/Shell";
import { storeFailureReport } from "@host/lib/storeFailure";
import * as Observability from "@shared/observability";
import { initDataDir } from "@shared/paths";
import * as Graph from "./graph";
import * as Loopback from "@host/socket/Loopback";
import { reapOrphanedConnector } from "@host/direct/Tunnel";
import { hostBinaryPath, setHostFacts, tunnelPidFile } from "./facts";
import * as HostLayer from "./layer";
import * as HostNodeServices from "./nodeServices";
import { startHost } from "./session";

// Every span that ends, a JSON line in host-trace.log beside the
// shell's trace.log, rotated to host-trace.old.log past 1 MB as the
// shell's is: a host that runs for weeks writes a line every few
// seconds while nothing happens. Written as each span ends, so a
// rotation has nothing still on its way to the file it moves. A test
// flavor's is kept whole: it is thrown away, and a failed lab run needs
// every minute of it.
function traceFile(logsPath: string, rotates: boolean): (line: string) => void {
  const path = join(logsPath, "host-trace.log");
  const open = (flags: "a" | "w") => {
    try {
      return openSync(path, flags);
    } catch {
      // No logs folder: the spans go unwritten.
      return null;
    }
  };
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    // No file yet.
  }
  let fd = open("a");
  return (line) => {
    if (rotates && size > 1_000_000) {
      if (fd !== null) closeSync(fd);
      let renamed = true;
      try {
        renameSync(path, join(logsPath, "host-trace.old.log"));
      } catch {
        renamed = false;
      }
      // A file that can't be moved aside starts over in place, so the
      // log stays bounded either way.
      fd = open(renamed ? "a" : "w");
      size = 0;
    }
    if (fd === null) return;
    const bytes = `${line}\n`;
    size += Buffer.byteLength(bytes);
    try {
      writeSync(fd, bytes);
    } catch {
      // A full disk: the span goes unwritten.
    }
  };
}

let hurried = false;
let runtime: { readonly dispose: () => Promise<void> } | null = null;

// The host is asked to stop: the answer leaves first, then the graph
// closes, which is the quit sequence (layer.ts), and the process ends
// with `code`. `hurried` is an update install or a relaunch, which
// signals scripts instead of waiting them out.
export function quit(asHurried: boolean, code = 0): void {
  hurried = asHurried;
  setImmediate(() => {
    void (runtime?.dispose() ?? Promise.resolve())
      .catch((error: unknown) => {
        log.error("[quit] a finalizer failed:", error);
      })
      .finally(() => process.exit(code));
  });
}

export async function runHost<E>(root: {
  readonly facts: Facts;
  // Over the platform's services, which the graph provides.
  readonly shell: Layer.Layer<
    Shell.Shell,
    E,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >;
  // The spans open now, which the Electron shell's beat reads.
  readonly openSpans: Observability.OpenSpans;
  // The host is up, on the loopback at `address`.
  readonly ready: (address: {
    readonly port: number;
    readonly token: string;
    readonly shellToken: string;
    readonly deviceId: string;
  }) => Promise<void>;
  // The graph couldn't come up, with the migration as the failure left
  // it. The process exits once this settles.
  readonly failed: (
    failure: typeof HostFailureSchema.Type,
    migration: MigrationProgress,
  ) => Promise<void>;
}): Promise<void> {
  const { facts } = root;
  setHostFacts(facts);
  const flavor = facts.flavor;
  // The connector a host that died unasked left running, killed first:
  // a boot that stalls later must not leave it running too. Awaited
  // before the graph, whose Tunnel writes the file again.
  const reaped = Effect.runPromise(
    reapOrphanedConnector(tunnelPidFile()).pipe(
      Effect.provide(
        childDefaults.pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    ),
  );
  // The shell has opened the data folder already, and says so when it
  // can't: this only names it for the host.
  await initDataDir(flavor);
  startHost({ quit });
  const engine = {
    flavor,
    nativefs: hostBinaryPath(NATIVEFS_DIST_DIR, NATIVEFS_BINARY_NAME),
    sm: hostBinaryPath(CLI_DIST_DIR, cliBinaryName(flavor)),
  };
  const migration = await Effect.runPromise(Migration.make);
  await reaped;
  // The root's door on top: open once every service is up (graph.ts).
  const graph = ManagedRuntime.make(
    Graph.layer.pipe(
      Layer.provideMerge(
        HostLayer.layer({ hurried: () => hurried, engine, migration }),
      ),
      // What the entry handed over: its facts and its calls.
      Layer.provideMerge(
        Layer.mergeAll(Layer.succeed(HostFacts.HostFacts, facts), root.shell),
      ),
      Layer.provideMerge(
        Observability.layer({
          packaged: facts.packaged,
          writeTraceLine: traceFile(facts.logsPath, !isTestFlavor(flavor)),
          openSpans: root.openSpans,
        }),
      ),
      Layer.provideMerge(childDefaults),
      Layer.provideMerge(HostNodeServices.layer),
    ),
  );
  runtime = graph;
  try {
    await graph.context();
  } catch (error) {
    log.error("[host] could not start:", error);
    Graph.failed(errorWordsOf(error));
    // A store the 2.x files couldn't be imported into, or that can't
    // be read: the doctor's findings say which file and what to do.
    const store = await storeFailureReport(error, {
      ...engine,
      version: facts.appVersion,
    });
    // The migration as the failure left it, which the graph's own telling
    // may not have reached the shell with: a stuck import shows its
    // reason on the migration's page, in place of the dialog.
    await root.failed(
      { message: errorWordsOf(error), store },
      await Effect.runPromise(migration.current),
    );
    process.exit(1);
  }
  const address = await Graph.run(
    Effect.flatMap(Loopback.Loopback, (it) => it.address),
  );
  await root.ready({
    ...address,
    deviceId: await Graph.run(DeviceId.current),
  });
}
