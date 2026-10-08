// The terminal `sm`: the engine's services under a command line, built
// with `bun build --compile`. The flavor (prod `sm`, dev `smd`) comes
// from the build.
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import * as Config from "@shigomori/engine/Config";
import * as Git from "@shigomori/engine/Git";
import * as Paths from "@shigomori/engine/Paths";
import * as Store from "@shigomori/engine/Store";
import { flavorNames } from "@shigomori/engine/flavor";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Command from "effect/cli/Command";
import { configCommand } from "./commands/config.ts";
import { report } from "./errors.ts";
import { Output } from "./output.ts";

declare const SM_FLAVOR: "prod" | "dev" | undefined;
declare const SM_VERSION: string | undefined;

const flavor = typeof SM_FLAVOR === "undefined" ? "dev" : SM_FLAVOR;
const version = typeof SM_VERSION === "undefined" ? "dev" : SM_VERSION;

// --json and --verbose are global wherever they sit, up to a `--`,
// past which everything is the command's.
function globalFlags(args: ReadonlyArray<string>) {
  const end = args.indexOf("--");
  const before = end === -1 ? args : args.slice(0, end);
  return {
    json: before.includes("--json"),
    verbose: before.includes("--verbose"),
    rest: [
      ...before.filter((arg) => arg !== "--json" && arg !== "--verbose"),
      ...(end === -1 ? [] : args.slice(end)),
    ],
  };
}

const sm = Command.make("sm").pipe(
  Command.withDescription("Shigoto no Mori"),
  Command.withSubcommands([configCommand]),
);

const { json, verbose, rest } = globalFlags(process.argv.slice(2));
const plain =
  json || process.env.NO_COLOR !== undefined || process.env.TERM === "dumb";

const engine = Config.layer.pipe(
  Layer.provideMerge(
    Store.layer((filename) => SqliteClient.make({ filename })),
  ),
  Layer.provideMerge(Git.layer),
  Layer.provideMerge(Paths.layer(flavor)),
  Layer.provideMerge(BunServices.layer),
);

const program = Command.runWith(sm, { version, renderErrors: false })(
  rest,
).pipe(
  Effect.provide(engine),
  Effect.as(0),
  Effect.catch(report),
  Effect.provideService(Output, {
    json,
    verbose,
    stdoutColor: !plain && process.stdout.isTTY === true,
    stderrColor: !plain && process.stderr.isTTY === true,
    binaryName: flavorNames(flavor).binaryName,
  }),
  Effect.flatMap((code) =>
    Effect.sync(() => {
      process.exitCode = code;
    }),
  ),
);

BunRuntime.runMain(program);
