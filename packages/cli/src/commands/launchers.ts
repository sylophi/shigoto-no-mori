// sm launchers [list] [-p <project>] [--catalog]: a project's launcher
// row, the list `sm open` picks from, or every app the catalog knows.
import * as Launchers from "@shigomori/engine/Launchers";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import { UsageError } from "../errors.ts";
import { projectFlags, resolveProject } from "../here.ts";
import { emit, note, out, Output, renderTable, styles } from "../output.ts";

// Every app the catalog knows, installed or not. Project-free.
const catalog = Effect.gen(function* () {
  const apps = yield* (yield* Launchers.Launchers).catalog;
  const { json, stdoutColor } = yield* Effect.service(Output);
  if (json) return yield* emit({ ok: true, apps });
  const { dim, green } = styles(stdoutColor);
  yield* out(
    renderTable(
      ["TOOL", "ID", ""],
      apps.map(({ label, id, available }) => [
        label,
        dim(id),
        available ? green("installed") : dim("not installed"),
      ]),
      stdoutColor,
    ),
  );
});

export const launchersCommand = Command.make(
  "launchers",
  {
    ...projectFlags,
    verb: Argument.String("list").pipe(Argument.optional),
    catalog: Flag.Boolean("catalog").pipe(
      Flag.withDescription("Every app the catalog knows, installed or not"),
      Flag.withDefault(false),
    ),
  },
  (input) =>
    Effect.gen(function* () {
      const { binaryName, json, stdoutColor, stderrColor } =
        yield* Effect.service(Output);
      const verb = Option.getOrElse(input.verb, () => "list");
      if (verb !== "list" && verb !== "ls") {
        return yield* new UsageError({
          problem: `Unknown subcommand ${JSON.stringify(verb)}. Usage: ${binaryName} launchers [list] [-p <project>] [--catalog]`,
        });
      }
      if (input.catalog) return yield* catalog;
      const project = yield* resolveProject(input);
      const row = yield* (yield* Launchers.Launchers).row(project);
      if (json) return yield* emit({ ok: true, ...row });
      if (row.entries.length === 0) {
        return yield* note(`No launchers available for ${project.name}.`);
      }
      const { dim } = styles(stdoutColor);
      yield* out(
        renderTable(
          ["LAUNCHER", "ID", "USES (14d)"],
          row.entries.map(({ label, id }) => [
            label,
            dim(id),
            String(row.usage[id]?.recentCount ?? 0),
          ]),
          stdoutColor,
        ),
      );
      if (row.hiddenCount > 0) {
        yield* note(styles(stderrColor).dim(`${row.hiddenCount} hidden`));
      }
    }),
).pipe(Command.withDescription("A project's launcher row"));
