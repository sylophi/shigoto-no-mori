// sm projects <list|add|remove|reorder|icon|config>: the registered
// projects, terrier's included, and each one's settings.
import { basename } from "node:path";
import { messageOf } from "@shigomori/engine/errorDocument";
import * as Icons from "@shigomori/engine/Icons";
import * as Projects from "@shigomori/engine/Projects";
import * as Registry from "@shigomori/engine/Registry";
import * as Worktrees from "@shigomori/engine/Worktrees";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import { Cancelled, UsageError } from "../errors.ts";
import {
  absolute,
  given,
  here,
  projectFlags,
  resolveProject,
  warnTerrier,
} from "../here.ts";
import { emit, note, out, Output, renderTable, styles } from "../output.ts";
import { confirm, interactive } from "../prompt.ts";
import { configVerbs, type Settings } from "./config.ts";

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
).pipe(Command.withDescription("List the projects, terrier's included"));

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
        project: Option.orElse(given(project), () => name),
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

// What each project setting is for, in the listing.
const projectDescriptions: Readonly<Record<string, string>> = {
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
};

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
          descriptions: projectDescriptions,
        } satisfies Settings;
      }),
    ),
  ),
);

const yesFlag = Flag.Boolean("yes").pipe(
  Flag.withAlias("y"),
  Flag.withDescription("Skip the confirmation"),
  Flag.withDefault(false),
);

// The line a person reads for a project just added.
const announce = (project: Registry.RegisteredProject) =>
  Effect.flatMap(Effect.service(Output), ({ stdoutColor }) =>
    out(styles(stdoutColor).green(`added ${project.name} (${project.path})`)),
  );

// A person's yes to adding the repos found under `root`.
const confirmAll = (root: string, found: Projects.Found) =>
  Effect.gen(function* () {
    const { repos, known } = found;
    if (!(yield* interactive)) {
      return yield* new UsageError({
        problem: `Refusing to add ${repos.length} projects without confirmation. Re-run with --yes, or interactively.`,
      });
    }
    const { cyan, dim } = styles((yield* Effect.service(Output)).stderrColor);
    yield* note(`Found ${repos.length} new repos under ${root}:`);
    yield* note("");
    for (const repo of repos) {
      yield* note(`  ${cyan(basename(repo))}  ${dim(repo)}`);
    }
    yield* note("");
    if (known > 0) yield* note(dim(`(${known} already registered)`));
    if (!(yield* confirm(`Add ${repos.length} projects?`))) {
      return yield* new Cancelled();
    }
  });

// Every repo under `root` that isn't a project yet.
const addAll = (root: string, yes: boolean) =>
  Effect.gen(function* () {
    const projects = yield* Projects.Projects;
    const { json } = yield* Effect.service(Output);
    const found = yield* projects.scan(root);
    if (found.repos.length === 0) {
      const already =
        found.known > 0 ? ` (${found.known} already registered)` : "";
      yield* note(`No new repos found under ${root}${already}.`);
      if (json) yield* emit([]);
      return;
    }
    if (!yes) yield* confirmAll(root, found);
    const added: Registry.RegisteredProject[] = [];
    for (const repo of found.repos) {
      const project = yield* projects.register(repo).pipe(Effect.result);
      if (Result.isFailure(project)) {
        yield* note(`warning: skipping ${repo}: ${messageOf(project.failure)}`);
        continue;
      }
      added.push(project.success);
      if (!json) yield* announce(project.success);
    }
    if (json) yield* emit(added);
  });

const add = Command.make(
  "add",
  {
    path: Argument.String("path").pipe(Argument.withDefault(".")),
    all: Flag.Boolean("all").pipe(
      Flag.withAlias("a"),
      Flag.withDescription("Every repo under the folder"),
      Flag.withDefault(false),
    ),
    yes: yesFlag,
  },
  (input) =>
    Effect.gen(function* () {
      yield* warnTerrier;
      const at = yield* absolute(input.path);
      if (input.all) return yield* addAll(at, input.yes);
      const project = yield* (yield* Projects.Projects).add(at);
      const { json } = yield* Effect.service(Output);
      yield* json ? emit(project) : announce(project);
    }),
).pipe(Command.withDescription("Add the repo a folder is in as a project"));

const remove = Command.make(
  "remove",
  {
    name: Argument.String("project").pipe(Argument.optional),
    projectId: projectFlags.projectId,
    yes: yesFlag,
  },
  (input) =>
    Effect.gen(function* () {
      const worktrees = yield* Worktrees.Worktrees;
      const projects = yield* Projects.Projects;
      const { json, binaryName } = yield* Effect.service(Output);
      const at = yield* here;
      const projectId = given(input.projectId);
      // The project picker waits for the terminal's menus.
      const project = Option.isSome(projectId)
        ? yield* worktrees.resolveProjectById(at, projectId.value)
        : Option.isSome(input.name)
          ? yield* worktrees.resolveProject(at, input.name.value)
          : yield* new UsageError({
              problem: `Specify a project to remove (see \`${binaryName} projects list\`).`,
            });
      if (!input.yes) {
        const left = yield* projects.leftovers(project);
        if (!(yield* interactive)) {
          return yield* new UsageError({
            problem: `Refusing to remove ${project.name} without confirmation. Re-run with --yes, or interactively.`,
          });
        }
        const remains =
          (left.worktrees > 0
            ? `Its ${left.worktrees} worktrees stay on disk.`
            : "No files are deleted from disk.") +
          (left.stillListed ? " It stays listed via terrier." : "");
        const sure = yield* confirm(
          `Remove ${project.name} (${project.path}) from Shigoto no Mori? ${remains}`,
        );
        if (!sure) return yield* new Cancelled();
      }
      yield* projects.remove(project);
      yield* json
        ? emit({ ok: true, removed: project.name, path: project.path })
        : out(`removed ${project.name} (${project.path})`);
    }),
).pipe(Command.withDescription("Remove a project. Its checkouts stay on disk"));

const reorder = Command.make(
  "reorder",
  { ids: Flag.String("ids").pipe(Flag.optional) },
  ({ ids }) =>
    Effect.gen(function* () {
      const { json, binaryName } = yield* Effect.service(Output);
      if (Option.isNone(ids)) {
        return yield* new UsageError({
          problem: `Usage: ${binaryName} projects reorder --ids <id1,id2,...>`,
        });
      }
      yield* warnTerrier;
      const registry = yield* Registry.Registry;
      yield* registry.reorder(
        yield* registry.listed,
        ids.value
          .split(",")
          .map((id) => id.trim())
          .filter((id) => id !== ""),
      );
      yield* json ? emit({ ok: true }) : out("reordered projects");
    }),
).pipe(Command.withDescription("Put projects first in the given order"));

export const projectsCommand = Command.make("projects").pipe(
  Command.withDescription("Project commands"),
  Command.withSubcommands([list, add, remove, reorder, icon, projectConfig]),
);
