// The terminal `sm`: the engine's services under a command line, built
// with `bun build --compile`, its flavor from the build (build.ts).
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { flavorNames } from "@shigomori/engine/flavor";
import * as Paths from "@shigomori/engine/Paths";
import * as Lifecycle from "@shigomori/engine/Lifecycle";
import { childDefaults } from "@shigomori/engine/processes";
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
import { adopt, create, move, rename, rm, setup } from "./commands/changes.ts";
import { done, land, merge, pr } from "./commands/landing.ts";
import { dirty } from "./commands/dirty.ts";
import { app, edit, open } from "./commands/open.ts";
import { update } from "./commands/update.ts";
import { nuke } from "./commands/nuke.ts";
import { login, logout } from "./commands/login.ts";
import { serviceCommand } from "./commands/service.ts";
import {
  bring,
  devices,
  mirror,
  mirrors,
  send,
  unmirror,
} from "./commands/transfer.ts";
import { cdCommand, shellCommand, switchCommand } from "./commands/shell.ts";
import { link, list, path, worktreesCommand } from "./commands/worktrees.ts";
import { describe } from "./commands/describe.ts";
import { autopull, shelve, unshelve } from "./commands/marks.ts";
import { agentsCommand } from "./commands/agents.ts";
import { guideCommand } from "./commands/guide.ts";
import { status } from "./commands/status.ts";
import { changingWithFix, doctor, engine } from "./engine.ts";
import { canonical } from "./aliases.ts";
import * as Here from "./here.ts";
import { commandLine, splitAtDashes } from "./argv.ts";
import { holdStdinFd } from "./stdinFd.ts";
import { verboseSpawner } from "./verbose.ts";
import { helpPages } from "./help.ts";
import { Killed, report } from "./errors.ts";
import {
  Output,
  outputFailure,
  READER_GONE,
  untilReaderGone,
  watchStreams,
} from "./output.ts";

// --json, --verbose and --version are global wherever they sit, up to
// a `--`, past which everything is the command's.
function globalFlags(args: ReadonlyArray<string>) {
  const { own, past } = splitAtDashes(args);
  return {
    version: own.includes("--version") || own.includes("-V"),
    json: own.includes("--json"),
    verbose: own.includes("--verbose"),
    rest: [
      ...own.filter((arg) => arg !== "--json" && arg !== "--verbose"),
      ...(past === undefined ? [] : ["--", ...past]),
    ],
  };
}

// Before any command runs a child (stdinFd.ts).
holdStdinFd();
// Before anything is written (output.ts).
watchStreams();

const {
  version: askedVersion,
  json,
  verbose,
  rest,
} = globalFlags(process.argv.slice(2));
const plain =
  json || (process.env.NO_COLOR ?? "") !== "" || process.env.TERM === "dumb";
const columns = Math.min(
  Math.max(process.stdout.columns || process.stderr.columns || 80, 60),
  110,
);
const help = helpPages({
  names: flavorNames(flavor),
  unshipped: flavor === "prod" ? null : flavor,
  color: !plain && process.stdout.isTTY === true,
  columns,
});

// Provided per command group, so help and usage errors open no store.
const services = engine(flavor);
// A command that reads where it runs.
const loaded = <Name extends string, Input, E, R>(
  command: Command.Command<Name, Input, {}, E, R>,
) =>
  command.pipe(
    Command.provideEffectDiscard(Here.bindCaller),
    Command.provide(services),
  );
const sm = Command.make("sm").pipe(
  Command.withSubcommands([
    configCommand.pipe(Command.provide(services)),
    loaded(projectsCommand),
    loaded(launchersCommand),
    shellCommand.pipe(
      Command.provide(
        Layer.mergeAll(ShellIntegration.layer, Lifecycle.layer).pipe(
          Layer.provide(childDefaults),
          Layer.provideMerge(Paths.layer(flavor)),
        ),
      ),
    ),
    loaded(cdCommand),
    loaded(switchCommand),
    loaded(runCommand),
    loaded(worktreesCommand),
    loaded(list),
    loaded(path),
    loaded(link),
    loaded(status),
    loaded(describe),
    loaded(shelve),
    loaded(unshelve),
    loaded(autopull),
    agentsCommand.pipe(Command.provide(services)),
    loaded(create),
    loaded(rm),
    loaded(move),
    loaded(rename),
    loaded(adopt),
    loaded(setup),
    loaded(pr),
    loaded(merge),
    loaded(land),
    loaded(done),
    loaded(dirty),
    loaded(open),
    loaded(edit),
    app.pipe(Command.provide(services)),
    loaded(send),
    loaded(bring),
    loaded(mirror),
    loaded(unmirror),
    loaded(mirrors),
    loaded(devices),
    login.pipe(Command.provide(services)),
    logout.pipe(Command.provide(services)),
    doctorCommand.pipe(changingWithFix, Command.provide(doctor(flavor))),
    update.pipe(Command.provide(services)),
    nuke.pipe(Command.provide(Paths.layer(flavor))),
    serviceCommand.pipe(Command.provide(Paths.layer(flavor))),
    guideCommand.pipe(Command.provide(services)),
  ]),
);

const program = commandLine(sm, canonical(rest, worktreesCommand)).pipe(
  Effect.flatMap(Command.runWith(sm, { version, renderErrors: false })),
  // None of effect/cli's built-in flags: the help is the catalog's
  // (help.ts), answered before parsing, and a command line the parser
  // refuses reports with the catalog's usage line where it has one,
  // without the parser's help page.
  Effect.provide(
    Layer.mergeAll(
      verbose
        ? Layer.merge(
            BunServices.layer,
            verboseSpawner.pipe(Layer.provide(BunServices.layer)),
          )
        : BunServices.layer,
      CliConfig.layer({ builtIns: [] }),
      Here.layer,
    ),
  ),
  Effect.provideService(Console.Console, { ...console, log: () => {} }),
  // Stdout's reader gone ends the command where it is (output.ts), and
  // says nothing.
  untilReaderGone,
  // A command whose output met a failed stream didn't say what it did.
  Effect.andThen((ended) => {
    const failed = outputFailure();
    return ended === READER_GONE || failed === undefined
      ? Effect.succeed({ code: 0, error: undefined as unknown })
      : Effect.fail(failed);
  }),
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
