// The terminal `sm`: the engine's services under a command line, built
// with `bun build --compile`. The flavor (prod `sm`, dev `smd`) comes
// from the build.
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { flavorNames } from "@shigomori/engine/flavor";
import * as Paths from "@shigomori/engine/Paths";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as CliConfig from "effect/cli/CliConfig";
import * as Command from "effect/cli/Command";
import * as GlobalFlag from "effect/cli/GlobalFlag";
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
import { cdCommand, shellCommand } from "./commands/shell.ts";
import {
  destination,
  list,
  path,
  worktreesCommand,
} from "./commands/worktrees.ts";
import { describe } from "./commands/describe.ts";
import { agentWorking, autopull, shelve, unshelve } from "./commands/marks.ts";
import { status } from "./commands/status.ts";
import { engine } from "./engine.ts";
import { Killed, report } from "./errors.ts";
import { Output } from "./output.ts";

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

// Go's aliases, folded before parsing, since effect/cli takes one per
// command: a namespace's, a worktree verb's (at the top level and after
// `worktrees`), and a project verb's, which differ: `rm` alone removes
// a worktree, after `projects` a project.
const VERBS: Readonly<Record<string, string>> = {
  ls: "list",
  l: "list",
  st: "status",
  "auto-pull": "autopull",
  new: "create",
  n: "create",
  remove: "rm",
  mv: "move",
  c: "cd",
  o: "open",
};
const PROJECT_VERBS: Readonly<Record<string, string>> = {
  ls: "list",
  rm: "remove",
};
const NAMESPACES: Readonly<Record<string, string>> = {
  worktree: "worktrees",
  wt: "worktrees",
  w: "worktrees",
  project: "projects",
  p: "projects",
  launcher: "launchers",
};

function canonical(args: ReadonlyArray<string>) {
  const [first, ...more] = args;
  if (first === undefined) return args;
  const command = NAMESPACES[first] ?? VERBS[first] ?? first;
  const [verb, ...after] = more;
  if (verb === undefined) return [command];
  if (command === "worktrees") return [command, VERBS[verb] ?? verb, ...after];
  if (command === "projects") {
    return [command, PROJECT_VERBS[verb] ?? verb, ...after];
  }
  return [command, ...more];
}

const { json, rest } = globalFlags(process.argv.slice(2));
const plain =
  json || process.env.NO_COLOR !== undefined || process.env.TERM === "dumb";

// Provided per command group, so help and usage errors open no store.
const services = engine(flavor);
const sm = Command.make("sm").pipe(
  Command.withDescription("Shigoto no Mori"),
  Command.withSubcommands([
    configCommand.pipe(Command.provide(services)),
    projectsCommand.pipe(Command.provide(services)),
    launchersCommand.pipe(Command.provide(services)),
    shellCommand.pipe(Command.provide(Paths.layer(flavor))),
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
    agentWorking.pipe(Command.provide(services)),
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
    doctorCommand.pipe(Command.provide(services)),
    update.pipe(Command.provide(services)),
  ]),
);

const program = Command.runWith(sm, { version, renderErrors: false })(
  canonical(rest),
).pipe(
  // Only --help of effect/cli's built-in flags, as Go has no others.
  Effect.provide(
    Layer.merge(
      BunServices.layer,
      CliConfig.layer({ builtIns: [GlobalFlag.Help] }),
    ),
  ),
  Effect.as({ code: 0, error: undefined as unknown }),
  // A defect reports like any failure, so --json still ends in a document.
  Effect.catchCause((cause) => {
    const error = Cause.squash(cause);
    return Effect.map(report(error), (code) => ({ code, error }));
  }),
  Effect.provideService(Output, {
    json,
    stdoutColor: !plain && process.stdout.isTTY === true,
    stderrColor: !plain && process.stderr.isTTY === true,
    width: Math.min(
      Math.max(process.stdout.columns || process.stderr.columns || 80, 60),
      110,
    ),
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

BunRuntime.runMain(program);
