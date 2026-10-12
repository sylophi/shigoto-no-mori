// The host's process: an Electron utility process the shell forks
// (main/hostProcess.ts) with its facts on the command line and a port
// in its first message, over which it calls the shell back
// (packages/contracts/src/modules/shellCalls.ts). It serves its windows,
// its shell and the terminal on the loopback, and its peers on the
// device link, until the shell asks it to stop (session:quit) or goes.
import { createWriteStream, openSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { errorWordsOf } from "@host/lib/errorWords";
import { ShellCallsGroup } from "@shigomori/contracts/link";
import { shellCallsContract } from "@shigomori/contracts/modules/shellCalls";
import { effectClient } from "@shared/ipc/effectClient";
import { log } from "@shared/log";
import { CLI_DIST_DIR, cliBinaryName } from "@shared/packaging/cliDist.mts";
import {
  MACFS_BINARY_NAME,
  MACFS_DIST_DIR,
} from "@shared/packaging/macfsDist.mts";
import { openPortLink } from "@shared/remote/portLink";
import * as DeviceId from "@host/lib/config/DeviceId";
import * as HostFacts from "@host/lib/HostFacts";
import { storeFailureReport } from "@host/lib/storeFailure";
import * as Observability from "@shared/observability";
import { initDataDir } from "@shared/paths";
import * as Graph from "./graph";
import * as Loopback from "@host/socket/Loopback";
import { hostBinaryPath, hostFacts } from "./facts";
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
  once(
    event: "message",
    listener: (event: { ports: ReadonlyArray<HostPort> }) => void,
  ): void;
};

// Every span that ends, a JSON line in host-trace.log beside the
// shell's trace.log, rotated to host-trace.old.log past 1 MB as the
// shell's is: a host that runs for weeks writes a line every few
// seconds while nothing happens.
function traceFile(logsPath: string): (line: string) => void {
  const path = join(logsPath, "host-trace.log");
  // Opened at once, so a rename moves the file this stream writes, and
  // what it has yet to write lands in the old one.
  const open = () => {
    try {
      const stream = createWriteStream("", { fd: openSync(path, "a") });
      stream.on("error", () => {});
      return stream;
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
  let stream = open();
  return (line) => {
    if (size > 1_000_000) {
      stream?.end();
      try {
        renameSync(path, join(logsPath, "host-trace.old.log"));
      } catch {
        // Gone already: the new stream starts it again.
      }
      stream = open();
      size = 0;
    }
    size += Buffer.byteLength(line) + 1;
    stream?.write(`${line}\n`);
  };
}

const facts = hostFacts();
const flavor = facts.flavor;
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
  // The root's door on top: open once every service is up (graph.ts).
  const graph = ManagedRuntime.make(
    Graph.layer.pipe(
      Layer.provideMerge(HostLayer.layer({ hurried: () => hurried, engine })),
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
    Graph.failed(errorWordsOf(error));
    // A store the 2.x files couldn't be imported into, or that can't
    // be read: the doctor's findings say which file and what to do.
    const storeReport = await storeFailureReport(error, {
      ...engine,
      version: facts.appVersion,
    });
    await Effect.runPromise(
      shell.failed({ message: errorWordsOf(error), storeReport }),
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
