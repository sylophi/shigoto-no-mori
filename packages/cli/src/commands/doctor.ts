// sm doctor [--fix [--yes]]: the checklist of what is wrong with this
// install, and the repairs that can put it right.
import * as Doctor from "@shigomori/engine/Doctor";
import { plural } from "@shigomori/engine/doctorParse";
import * as Paths from "@shigomori/engine/Paths";
import * as Effect from "effect/Effect";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import { version } from "../build.ts";
import { ExitCode, UsageError } from "../errors.ts";
import {
  alignRows,
  collapseHome,
  emit,
  note,
  out,
  Output,
  styles,
} from "../output.ts";
import { confirm, interactive } from "../prompt.ts";

const GROUPS: ReadonlyArray<Doctor.Group> = [
  "Environment",
  "Data dir",
  "Processes",
  "Projects",
];

// Asks before a destructive repair: --yes says yes, a person at a
// terminal is asked, and anyone else is told it was skipped.
const approve = (yes: boolean) =>
  Effect.gen(function* () {
    const output = yield* Effect.service(Output);
    const asking = yield* interactive;
    const { dim } = styles(output.stderrColor);
    return (repair: Doctor.Repair) =>
      Effect.gen(function* () {
        if (yes) return true;
        if (!asking) {
          yield* note(
            dim(
              `skipped: ${repair.label} (re-run with --yes, or interactively)`,
            ),
          );
          return false;
        }
        const sure = yield* confirm(repair.prompt);
        if (!sure) yield* note(dim(`skipped: ${repair.label}`));
        return sure;
      }).pipe(Effect.provideService(Output, output));
  });

// Says each repair that failed as it happens, between the questions.
const failed = Effect.map(Effect.service(Output), ({ stderrColor }) => {
  const { yellow } = styles(stderrColor);
  return (line: string) => note(yellow(line));
});

// The checklist as a person reads it: a header, each group's lines with
// their fixes, what was repaired, and the counts.
const render = (doc: Doctor.DoctorDocument, fix: boolean) =>
  Effect.gen(function* () {
    const { stdoutColor, binaryName } = yield* Effect.service(Output);
    const { home } = yield* Paths.Paths;
    const { bold, cyan, dim, green, red, yellow } = styles(stdoutColor);
    const glyph = (status: Doctor.Status) =>
      status === "ok" ? green("✓") : status === "warn" ? yellow("!") : red("✗");
    const where = collapseHome(home, doc.dataDir);
    yield* out(
      `${bold(`${binaryName} doctor`)} ${dim(`${doc.version} (${doc.flavor})`)}  data dir ${cyan(where)}`,
    );
    yield* out("");
    for (const group of GROUPS) {
      const shown = doc.checks.filter((check) => check.group === group);
      if (shown.length === 0) continue;
      yield* out(bold(group));
      const lines = alignRows(
        shown.map((check) => [glyph(check.status), check.title, check.detail]),
      );
      for (const [index, line] of lines.entries()) {
        yield* out(`  ${line}`);
        const check = shown[index];
        if (!check?.fix) continue;
        // That --fix can do it is the terminal's to add: the app offers
        // a button.
        const can =
          check.repairable && !fix
            ? ` (\`${binaryName} doctor --fix\` does this)`
            : "";
        yield* out(`    ${dim(`fix: ${check.fix}${can}`)}`);
      }
      yield* out("");
    }
    if (doc.repaired.length > 0) {
      yield* out(bold("Repaired"));
      for (const label of doc.repaired) yield* out(`  ${green("✓")} ${label}`);
      yield* out("");
    }
    const { ok, warn, fail } = doc.summary;
    const parts = [`${ok} ok`];
    if (warn > 0) parts.push(yellow(`${warn} warning${plural(warn)}`));
    if (fail > 0) parts.push(red(`${fail} failed`));
    yield* out(parts.join(", "));
    const repairable = doc.checks.filter((check) => check.repairable).length;
    if (!fix && repairable > 0) {
      yield* out(
        dim(
          `${repairable} of them can be repaired: run \`${binaryName} doctor --fix\`.`,
        ),
      );
    }
  });

export const doctorCommand = Command.make(
  "doctor",
  {
    rest: Argument.String("args").pipe(Argument.variadic()),
    fix: Flag.Boolean("fix").pipe(
      Flag.withDescription("Apply the repairs the checks offer"),
      Flag.withDefault(false),
    ),
    yes: Flag.Boolean("yes").pipe(
      Flag.withAlias("y"),
      Flag.withDescription("Say yes to the repairs that delete something"),
      Flag.withDefault(false),
    ),
  },
  ({ rest, fix, yes }) =>
    Effect.gen(function* () {
      if (rest.length > 0) {
        return yield* new UsageError({
          problem: "doctor takes no arguments (flags: --fix, --yes).",
        });
      }
      if (yes && !fix) {
        return yield* new UsageError({
          problem: "--yes only means anything with --fix.",
        });
      }
      const doc = yield* (yield* Doctor.Doctor).run({
        version,
        executable: process.execPath,
        terminal: yield* interactive,
        ...(fix
          ? { fix: { approve: yield* approve(yes), failed: yield* failed } }
          : {}),
      });
      const { json } = yield* Effect.service(Output);
      yield* json ? emit(doc) : render(doc, fix);
      // Every failure is on the checklist already.
      if (!doc.ok) return yield* new ExitCode({ code: 1 });
    }),
).pipe(Command.withDescription("Check this install, and repair it with --fix"));
