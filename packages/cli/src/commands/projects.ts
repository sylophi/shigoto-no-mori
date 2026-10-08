// sm projects <list|icon|config>: the registered projects, terrier's
// included, and each one's settings.
import * as Icons from "@shigomori/engine/Icons";
import * as Registry from "@shigomori/engine/Registry";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import { resolveProject, warnTerrier } from "../here.ts";
import { emit, note, out, Output, renderTable } from "../output.ts";
import { configVerbs } from "./config.ts";

// How a command names its project, beside or instead of a positional.
export const projectFlags = {
  project: Flag.String("project").pipe(Flag.withAlias("p"), Flag.optional),
  projectId: Flag.String("project-id").pipe(Flag.optional),
};

const refreshIconsFlag = Flag.Boolean("refresh-icons").pipe(
  Flag.withDescription(
    "Look again for icons of projects remembered as having none",
  ),
  Flag.withDefault(false),
);

const list = Command.make(
  "list",
  { refreshIcons: refreshIconsFlag },
  ({ refreshIcons }) =>
    Effect.gen(function* () {
      yield* warnTerrier;
      const registry = yield* Registry.Registry;
      const { json, stdoutColor } = yield* Effect.service(Output);
      if (json) {
        return yield* emit(
          yield* registry.rows({ rescanIconMisses: refreshIcons }),
        );
      }
      const projects = yield* registry.listed;
      if (projects.length === 0) return yield* note("No projects registered.");
      // The VIA column only once something goes in it.
      const via = projects.some((project) => project.source !== undefined);
      yield* out(
        renderTable(
          via ? ["NAME", "PATH", "VIA"] : ["NAME", "PATH"],
          projects.map(({ name, path, source }) =>
            via ? [name, path, source ?? ""] : [name, path],
          ),
          stdoutColor,
        ),
      );
    }),
).pipe(
  Command.withAlias("ls"),
  Command.withDescription("List the projects, terrier's included"),
);

const icon = Command.make(
  "icon",
  {
    ...projectFlags,
    name: Argument.String("project").pipe(Argument.optional),
    refreshIcons: refreshIconsFlag,
  },
  ({ project, projectId, name, refreshIcons }) =>
    Effect.gen(function* () {
      const found = yield* resolveProject({
        projectId,
        project: Option.orElse(project, () => name),
      });
      const icons = yield* Icons.Icons;
      const options = { rescanMisses: refreshIcons };
      const { json } = yield* Effect.service(Output);
      if (json) {
        return yield* emit(
          Option.getOrNull(yield* icons.bytes(found.path, options)),
        );
      }
      const ref = yield* icons.of(found.path, options);
      yield* Option.match(ref, {
        onNone: () => note(`No icon found for ${found.name}.`),
        onSome: ({ path }) => out(path),
      });
    }),
).pipe(Command.withDescription("Print the project's icon"));

// The project settings' parent: -p and --project-id go before or after
// the verb.
const settingsOf = Command.make("config").pipe(
  Command.withSharedFlags(projectFlags),
);

const projectConfig = settingsOf.pipe(
  Command.withDescription("A project's settings"),
  Command.withSubcommands(
    configVerbs(
      Effect.gen(function* () {
        const found = yield* resolveProject(yield* settingsOf);
        return {
          scope: { kind: "project", projectId: found.id, path: found.path },
          project: found.name,
          listCommand: "projects config list",
          descriptions: {
            defaultBranch: "Branch new worktrees fork from (required)",
            "scripts.setup": "Runs after creating a worktree",
            "scripts.teardown": "Runs before removing a worktree",
            worktreeLayout: "Where managed worktrees live",
            customWorktreePath: "Absolute base dir for the custom layout",
            useWorktreeInclude: "Honor the repo's .worktreeinclude file",
            portBase: "port-pool base port",
            lastMergeMethod: "Preferred PR merge method",
            showPrimaryInInbox: "List the primary checkout in the inbox view",
            carryOver: "Files carried into new worktrees (`carryover` verbs)",
            launchers: "Per-project launchers (`launcher` verbs)",
          },
        } as const;
      }),
    ),
  ),
);

export const projectsCommand = Command.make("projects").pipe(
  Command.withAlias("p"),
  Command.withDescription("Project commands"),
  Command.withSubcommands([list, icon, projectConfig]),
);
