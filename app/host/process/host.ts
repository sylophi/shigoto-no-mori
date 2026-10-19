// The host's process: an Electron utility process the shell forks
// (main/hostProcess.ts) with its facts on the command line and a port
// in its first message, over which it calls the shell back
// (packages/contracts/src/modules/shellCalls.ts). It serves its windows,
// its shell and the terminal on the loopback, and its peers on the
// device link, until the shell asks it to stop (session:quit) or goes.
import { closeSync, openSync, renameSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { isTestFlavor } from "@shigomori/engine/flavor";
import { childDefaults } from "@shigomori/engine/processes";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { errorWordsOf } from "@host/lib/errorWords";
import { ShellCallsGroup } from "@shigomori/contracts/link";
import { shellCallsContract } from "@shigomori/contracts/modules/shellCalls";
import { effectClient } from "@shared/ipc/effectClient";
import { beatOf } from "@shared/hostBeat";
import { log } from "@shared/log";
import { CLI_DIST_DIR, cliBinaryName } from "@shared/packaging/cliDist.mts";
import {
  MACFS_BINARY_NAME,
  MACFS_DIST_DIR,
} from "@shared/packaging/macfsDist.mts";
import { openPortLink } from "@shared/remote/portLink";
import * as Migration from "@shigomori/engine/Migration";
import * as DeviceId from "@host/lib/config/DeviceId";
import * as HostFacts from "@host/lib/HostFacts";
import { storeFailureReport } from "@host/lib/storeFailure";
import * as Observability from "@shared/observability";
import { initDataDir } from "@shared/paths";
import * as Graph from "./graph";
import * as Loopback from "@host/socket/Loopback";
import { reapOrphanedConnector } from "@host/direct/Tunnel";
import { hostBinaryPath, hostFacts, tunnelPidFile } from "./facts";
import * as HostLayer from "./layer";
import * as ShellLayer from "./shell";
import { startHost } from "./session";

// The utility process's port to its parent, and the port the shell
// hands over on it, as much of Electron's types as the host reads
// (host/ never imports electron, its types included).
type HostPort = {
  postMessage(data: unknown): void;
  close(): void;
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  on(event: "close", listener: () => void): void;
  start(): void;
};
type ParentPort = {
  postMessage(message: unknown): void;
  once(
    event: "message",
    listener: (event: { ports: ReadonlyArray<HostPort> }) => void,
  ): void;
};

// Every span that ends, a JSON line in host-trace.log beside the
// shell's trace.log, rotated to host-trace.old.log past 1 MB as the
// shell's is: a host that runs for weeks writes a line every few
// seconds while nothing happens. Written as each span ends, so a
// rotation has nothing still on its way to the file it moves. A test
// flavor's is kept whole: it is thrown away, and a failed walk needs
// every minute of its run.
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

const facts = hostFacts();
const flavor = facts.flavor;
// Electron adds parentPort to a utility process, and its types are Electron's
const parentPort = (process as { parentPort: ParentPort }).parentPort;

// The loop's beat, which the shell reads (main/hostProcess.ts): a loop
// stuck before the host is up stops it, and the spans open at the last
// beat name what a stuck host was doing.
const BEAT_EVERY_MS = 5_000;
const openSpans: Observability.OpenSpans = new Map();
const beat = () => {
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a utility process's parent port, which has no origin
  parentPort.postMessage(beatOf(openSpans, performance.now()));
};
beat();
setInterval(beat, BEAT_EVERY_MS).unref();

// The connector a host that died unasked left running, killed first:
// a boot that stalls later must not leave it running too. Awaited before
// the graph, whose Tunnel writes the file again.
const reaped = Effect.runPromise(
  reapOrphanedConnector(tunnelPidFile()).pipe(
    Effect.provide(childDefaults.pipe(Layer.provideMerge(NodeServices.layer))),
  ),
);

let hurried = false;
let runtime: { readonly dispose: () => Promise<void> } | null = null;

// The shell asked the host to stop: the answer leaves first, then the
// graph closes, which is the quit sequence (layer.ts), and the process
// ends.
function quit(asHurried: boolean): void {
  hurried = asHurried;
  setImmediate(() => {
    void (runtime?.dispose() ?? Promise.resolve())
      .catch((error: unknown) => {
        log.error("[quit] a finalizer failed:", error);
      })
      .finally(() => process.exit(0));
  });
}

async function main(): Promise<void> {
  const port = await new Promise<HostPort>((resolve) => {
    parentPort.once("message", (event) => {
      const handed = event.ports[0];
      if (handed !== undefined) resolve(handed);
    });
  });
  const shell = effectClient(
    shellCallsContract,
    await openPortLink(
      {
        // A frame is a view into a buffer the encoder goes on writing,
        // which a port would clone whole: only its own bytes go.
        postMessage: (data) => port.postMessage(data.slice()),
        close: () => port.close(),
        listen: (onMessage, onClose) => {
          port.on("message", (event) => onMessage(event.data));
          port.on("close", onClose);
          port.start();
        },
      },
      ShellCallsGroup,
    ),
  );
  // The shell has opened the data folder already, and says so when it
  // can't: this only names it for the host.
  await initDataDir(flavor);
  startHost({ quit });
  const engine = {
    flavor,
    macfs: hostBinaryPath(MACFS_DIST_DIR, MACFS_BINARY_NAME),
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
      // What the shell handed over: its facts and its calls.
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.succeed(HostFacts.HostFacts, facts),
          ShellLayer.layer(shell),
        ),
      ),
      Layer.provideMerge(
        Observability.layer({
          packaged: facts.packaged,
          writeTraceLine: traceFile(facts.logsPath, !isTestFlavor(flavor)),
          openSpans,
        }),
      ),
      Layer.provideMerge(childDefaults),
      Layer.provideMerge(NodeServices.layer),
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
    await Effect.runPromise(
      migration.current.pipe(
        Effect.flatMap(shell.migration),
        Effect.andThen(shell.failed({ message: errorWordsOf(error), store })),
      ),
    );
    process.exit(1);
  }
  const address = await Graph.run(
    Effect.flatMap(Loopback.Loopback, (it) => it.address),
  );
  await Effect.runPromise(
    shell.ready({ ...address, deviceId: await Graph.run(DeviceId.current) }),
  );
}

void main().catch((error: unknown) => {
  log.error("[host] could not start:", error);
  process.exit(1);
});
