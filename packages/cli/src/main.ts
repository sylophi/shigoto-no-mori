// The terminal `sm`: the engine's services under a command line, built
// with `bun build --compile`. The flavor (prod `sm`, dev `smd`) comes
// from the build.
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { flavorNames } from "@shigomori/engine/flavor";
import * as Paths from "@shigomori/engine/Paths";
import * as ShellIntegration from "@shigomori/engine/ShellIntegration";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as CliConfig from "effect/cli/CliConfig";
import * as Command from "effect/cli/Command";
import { configCommand } from "./commands/config.ts";
import { launchersCommand } from "./commands/launchers.ts";
import { projectsCommand } from "./commands/projects.ts";
import { flavor, version } from "./build.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { runCommand } from "./commands/run.ts";
import { adopt, create, move, rekey, rm, setup } from "./commands/changes.ts";
import { done, land, merge, pr } from "./commands/landing.ts";
import { dirty } from "./commands/dirty.ts";
import { bundle } from "./commands/bundle.ts";
import { open } from "./commands/open.ts";
import { update } from "./commands/update.ts";
import {
  bring,
  devices,
  mirror,
  mirrors,
  send,
  unmirror,
} from "./commands/transfer.ts";
import { cdCommand, shellCommand } from "./commands/shell.ts";
import {
  destination,
  list,
  path,
  worktreesCommand,
} from "./commands/worktrees.ts";
import { describe } from "./commands/describe.ts";
import { autopull, shelve, unshelve } from "./commands/marks.ts";
import { agentsCommand } from "./commands/agents.ts";
import { status } from "./commands/status.ts";
import { doctor, engine } from "./engine.ts";
import { canonical } from "./aliases.ts";
import { helpPages } from "./help.ts";
import { Killed, report } from "./errors.ts";
import { Output } from "./output.ts";

// --json, --verbose and --version are global wherever they sit, up to
// a `--`, past which everything is the command's, as in Go.
// --verbose is accepted and has nothing to add yet.
function globalFlags(args: ReadonlyArray<string>) {
  const end = args.indexOf("--");
  const before = end === -1 ? args : args.slice(0, end);
  return {
    version: before.includes("--version") || before.includes("-V"),
    json: before.includes("--json"),
    rest: [
      ...before.filter((arg) => arg !== "--json" && arg !== "--verbose"),
      ...(end === -1 ? [] : args.slice(end)),
    ],
  };
}

const {
  version: askedVersion,
  json,
  rest,
} = globalFlags(process.argv.slice(2));
const plain =
  json || process.env.NO_COLOR !== undefined || process.env.TERM === "dumb";
const columns = Math.min(
  Math.max(process.stdout.columns || process.stderr.columns || 80, 60),
  110,
);
const help = helpPages({
  names: flavorNames(flavor),
  dev: flavor !== "prod",
  color: !plain && process.stdout.isTTY === true,
  columns,
});

// Provided per command group, so help and usage errors open no store.
const services = engine(flavor);
const sm = Command.make("sm").pipe(
  Command.withDescription("Shigoto no Mori"),
  Command.withSubcommands([
    configCommand.pipe(Command.provide(services)),
    projectsCommand.pipe(Command.provide(services)),
    launchersCommand.pipe(Command.provide(services)),
    shellCommand.pipe(
      Command.provide(
        ShellIntegration.layer.pipe(Layer.provideMerge(Paths.layer(flavor))),
      ),
    ),
    cdCommand.pipe(Command.provide(services)),
    runCommand.pipe(Command.provide(services)),
    worktreesCommand.pipe(Command.provide(services)),
    list.pipe(Command.provide(services)),
    path.pipe(Command.provide(services)),
    destination.pipe(Command.provide(services)),
    status.pipe(Command.provide(services)),
    describe.pipe(Command.provide(services)),
    shelve.pipe(Command.provide(services)),
    unshelve.pipe(Command.provide(services)),
    autopull.pipe(Command.provide(services)),
    agentsCommand.pipe(Command.provide(services)),
    create.pipe(Command.provide(services)),
    rm.pipe(Command.provide(services)),
    move.pipe(Command.provide(services)),
    adopt.pipe(Command.provide(services)),
    setup.pipe(Command.provide(services)),
    rekey.pipe(Command.provide(services)),
    pr.pipe(Command.provide(services)),
    merge.pipe(Command.provide(services)),
    land.pipe(Command.provide(services)),
    done.pipe(Command.provide(services)),
    dirty.pipe(Command.provide(services)),
    bundle.pipe(Command.provide(services)),
    open.pipe(Command.provide(services)),
    send.pipe(Command.provide(services)),
    bring.pipe(Command.provide(services)),
    mirror.pipe(Command.provide(services)),
    unmirror.pipe(Command.provide(services)),
    mirrors.pipe(Command.provide(services)),
    devices.pipe(Command.provide(services)),
    doctorCommand.pipe(Command.provide(doctor(flavor))),
    update.pipe(Command.provide(services)),
  ]),
);

const program = Command.runWith(sm, { version, renderErrors: false })(
  canonical(rest),
).pipe(
  // None of effect/cli's built-in flags: the help is the catalog's
  // (help.ts), answered before parsing, and a command line the parser
  // refuses reports as Go's did, without the parser's help page.
  Effect.provide(
    Layer.merge(BunServices.layer, CliConfig.layer({ builtIns: [] })),
  ),
  Effect.provideService(Console.Console, { ...console, log: () => {} }),
  Effect.as({ code: 0, error: undefined as unknown }),
  // A defect reports like any failure, so --json still ends in a document.
  Effect.catchCause((cause) => {
    const error = Cause.squash(cause);
    return Effect.map(report(error, help.usageOf), (code) => ({
      code,
      error,
    }));
  }),
  Effect.provideService(Output, {
    json,
    stdoutColor: !plain && process.stdout.isTTY === true,
    stderrColor: !plain && process.stderr.isTTY === true,
    width: columns,
    binaryName: flavorNames(flavor).binaryName,
  }),
  Effect.flatMap(({ code, error }) =>
    Effect.sync(() => {
      process.exitCode = code;
      // On the way out, once the runtime has let go of its own handlers,
      // so the signal's default action ends sm. The code stands in should
      // it not.
      if (error instanceof Killed && error.raised) {
        process.once("exit", () => process.kill(process.pid, error.signal));
      }
    }),
  ),
);

// The version alone, whatever else was asked, then the help.
const asked = askedVersion ? undefined : help.asked(rest);
if (askedVersion) {
  process.stdout.write(`${version}\n`);
} else if (asked !== undefined) {
  process.stdout.write(`${asked.text}\n`);
  process.exitCode = asked.code;
} else {
  BunRuntime.runMain(program);
}
