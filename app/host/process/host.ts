// The host's process: an Electron utility process the shell forks
// (main/hostProcess.ts) with its facts on the command line and a port
// in its first message, over which it calls the shell back
// (packages/contracts/src/modules/shellCalls.ts). It serves its windows,
// its shell and the terminal on the loopback, and its peers on the
// device link, until the shell asks it to stop (session:quit) or goes.
import { createWriteStream, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import { errorMessageOf } from "@shigomori/contracts/errors";
import { ShellCallsGroup } from "@shigomori/contracts/link";
import { shellCallsContract } from "@shigomori/contracts/modules/shellCalls";
import { buildClient } from "@shared/ipc/buildClient";
import { log } from "@shared/log";
import { CLI_DIST_DIR, cliBinaryName } from "@shared/packaging/cliDist.mts";
import {
  MACFS_BINARY_NAME,
  MACFS_DIST_DIR,
} from "@shared/packaging/macfsDist.mts";
import { openPortLink } from "@shared/remote/portLink";
import { getDeviceId } from "@host/lib/config/deviceId";
import { storeFailureReport } from "@host/lib/storeFailure";
import * as Observability from "@host/lib/util/observability";
import { initDataDir } from "@host/lib/util/paths";
import * as Graph from "./graph";
import * as Loopback from "@host/socket/loopback";
import {
  flavorOf,
  HOST_FACTS_FLAG,
  type HostFacts,
  HostFactsSchema,
  hostBinaryPath,
} from "./facts";
import * as HostLayer from "./layer";
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
  once(
    event: "message",
    listener: (event: { ports: ReadonlyArray<HostPort> }) => void,
  ): void;
};

function factsFromArgv(): HostFacts {
  const arg = process.argv.find((value) => value.startsWith(HOST_FACTS_FLAG));
  if (arg === undefined) throw new Error("the host was started without facts");
  return Schema.decodeUnknownSync(Schema.fromJsonString(HostFactsSchema))(
    arg.slice(HOST_FACTS_FLAG.length),
  );
}

// Every span that ends, a JSON line in host-trace.log beside the
// shell's trace.log, rotated to host-trace.old.log past 1 MB at start.
function traceFile(logsPath: string): (line: string) => void {
  const path = join(logsPath, "host-trace.log");
  try {
    if (statSync(path).size > 1_000_000) {
      renameSync(path, join(logsPath, "host-trace.old.log"));
    }
  } catch {
    // No file yet.
  }
  const stream = createWriteStream(path, { flags: "a" });
  stream.on("error", () => {});
  return (line) => void stream.write(`${line}\n`);
}

const facts = factsFromArgv();
const flavor = flavorOf(facts);
// oxlint-disable-next-line shigomori/no-double-cast -- Electron adds parentPort to a utility process, and its types are Electron's
const parentPort = (process as unknown as { parentPort: ParentPort })
  .parentPort;

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
  const shell = buildClient(
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
  startHost({
    facts,
    shell: {
      relaunch: () => shell.relaunch(),
      updater: {
        check: () => shell.updaterCheck(),
        install: (unattended) => shell.updaterInstall({ unattended }),
        update: (unattended) => shell.updaterUpdate({ unattended }),
      },
      stopUpdaterBridge: () => shell.stopUpdaterBridge(),
    },
    quit,
  });
  const engine = {
    flavor,
    macfs: hostBinaryPath(MACFS_DIST_DIR, MACFS_BINARY_NAME),
    sm: hostBinaryPath(CLI_DIST_DIR, cliBinaryName(flavor)),
  };
  // The root's door on top: open once every service is up (graph.ts).
  const graph = ManagedRuntime.make(
    Graph.layer.pipe(
      Layer.provideMerge(HostLayer.layer({ hurried: () => hurried, engine })),
      Layer.provideMerge(
        Observability.layer({
          packaged: facts.packaged,
          writeTraceLine: traceFile(facts.logsPath),
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
    ),
  );
  runtime = graph;
  try {
    await graph.context();
  } catch (error) {
    Graph.failed(errorMessageOf(error));
    // A store the 2.x files couldn't be imported into, or that can't
    // be read: the doctor's findings say which file and what to do.
    await shell.failed({
      message: errorMessageOf(error),
      storeReport: await storeFailureReport(error, {
        ...engine,
        version: facts.appVersion,
      }),
    });
    process.exit(1);
  }
  await shell.ready({
    ...(await Graph.run(Effect.flatMap(Loopback.Loopback, (it) => it.address))),
    deviceId: getDeviceId(),
  });
}

void main().catch((error: unknown) => {
  log.error("[host] could not start:", error);
  process.exit(1);
});
