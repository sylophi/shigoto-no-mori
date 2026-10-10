// A host that the terminals proof kills mid-stream: it opens a device
// terminal over the store in SHIGOMORI_DATA_DIR, starts the command in
// argv[2] in it, and prints the terminal's id.
//
// Run: node --import ./test/lib/register-ts-alias.mts
//        test/lib/terminalsHost.mts <command>
import * as Effect from "effect/Effect";
import * as Terminals from "../../host/lib/terminals/Terminals.ts";
import { launchTerminals } from "./terminalsApp.mts";

const app = launchTerminals({
  home: process.env.HOME ?? "/",
  dataDir: process.env.SHIGOMORI_DATA_DIR ?? "",
  start: () =>
    Effect.succeed({
      env: { ...process.env, PS1: "$ ", TERM: "xterm-256color" },
    }),
});
const { terminalId } = await app.runPromise(
  Effect.flatMap(Terminals.Terminals, (terminals) =>
    Effect.tap(terminals.open({ owner: { kind: "device" } }), (terminal) =>
      terminals.write(terminal.terminalId, `${process.argv[2]}\r`),
    ),
  ),
);
process.stdout.write(`${terminalId}\n`);
