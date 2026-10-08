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
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as CliConfig from "effect/cli/CliConfig";
import * as Command from "effect/cli/Command";
import * as GlobalFlag from "effect/cli/GlobalFlag";
import { configCommand } from "./commands/config.ts";
import { report } from "./errors.ts";
import { Output } from "./output.ts";

declare const SM_FLAVOR: "prod" | "dev" | undefined;

const flavor = typeof SM_FLAVOR === "undefined" ? "dev" : SM_FLAVOR;

// --json and --verbose are global wherever they sit, up to a `--`,
// past which everything is the command's, as in Go.
// --verbose is accepted and has nothing to add yet.
function globalFlags(args: ReadonlyArray<string>) {
  const end = args.indexOf("--");
  const before = end === -1 ? args : args.slice(0, end);
  return {
    json: before.includes("--json"),
    rest: [
      ...before.filter((arg) => arg !== "--json" && arg !== "--verbose"),
      ...(end === -1 ? [] : args.slice(end)),
    ],
  };
}

const { json, rest } = globalFlags(process.argv.slice(2));
const plain =
  json || process.env.NO_COLOR !== undefined || process.env.TERM === "dumb";

const engine = Config.layer.pipe(
  Layer.provideMerge(
    Store.layer((filename) => SqliteClient.make({ filename })),
  ),
  Layer.provideMerge(Git.layer),
  Layer.provideMerge(Paths.layer(flavor)),
);

// Provided per command group, so help and usage errors open no store.
const sm = Command.make("sm").pipe(
  Command.withDescription("Shigoto no Mori"),
  Command.withSubcommands([configCommand.pipe(Command.provide(engine))]),
);

const program = Command.runWith(sm, { version: "dev", renderErrors: false })(
  rest,
).pipe(
  // Only --help of effect/cli's built-in flags, as Go has no others.
  Effect.provide(
    Layer.merge(
      BunServices.layer,
      CliConfig.layer({ builtIns: [GlobalFlag.Help] }),
    ),
  ),
  Effect.as(0),
  // A defect reports like any failure, so --json still ends in a document.
  Effect.catchCause((cause) => report(Cause.squash(cause))),
  Effect.provideService(Output, {
    json,
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
