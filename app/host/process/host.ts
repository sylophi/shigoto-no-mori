// The host's process as the Electron shell runs it: a utility process
// the shell forks (main/hostProcess.ts) with its facts on the command
// line and a port in its first message, over which it calls the shell
// back (packages/contracts/src/modules/shellCalls.ts). The run itself
// is run.ts's, until the shell asks it to stop (session:quit) or goes.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ShellCallsGroup } from "@shigomori/contracts/link";
import { shellCallsContract } from "@shigomori/contracts/modules/shellCalls";
import { effectClient } from "@shared/ipc/effectClient";
import { beatOf } from "@shared/hostBeat";
import { HOST_FACTS_FLAG, HostFactsSchema } from "@shared/hostFacts";
import { log } from "@shared/log";
import type * as Observability from "@shared/observability";
import { openPortLink } from "@shared/remote/portLink";
import * as ShellLayer from "./shell";
import { runHost } from "./run";

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

const factsArg = process.argv.find((value) =>
  value.startsWith(HOST_FACTS_FLAG),
);
if (factsArg === undefined) {
  throw new Error("the host was started without facts");
}
const facts = Schema.decodeSync(Schema.fromJsonString(HostFactsSchema))(
  factsArg.slice(HOST_FACTS_FLAG.length),
);
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
  await runHost({
    facts,
    shell: ShellLayer.layer(shell),
    openSpans,
    ready: (address) => Effect.runPromise(shell.ready(address)),
    failed: (failure, migration) =>
      Effect.runPromise(
        shell.migration(migration).pipe(Effect.andThen(shell.failed(failure))),
      ),
  });
}

void main().catch((error: unknown) => {
  log.error("[host] could not start:", error);
  process.exit(1);
});
