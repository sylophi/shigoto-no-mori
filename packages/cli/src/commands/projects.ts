// sm projects <list|icon|add|clone|unregister|delete|relocate|config>: the
// registered projects, terrier's included (and written through to it),
// and each one's settings. clone is a cross-device verb (transfer.ts).
import { basename } from "node:path";
import {
  keyDescriptions,
  ShigomoriConfigSchema,
} from "@shigomori/contracts/schemas/config";
import * as Config from "@shigomori/engine/Config";
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
import { changing } from "../engine.ts";
import * as Flag from "effect/cli/Flag";
import { Cancelled, UsageError } from "../errors.ts";
import {
  absolute,
  given,
  here,
  projectFlags,
  resolveProject,
  rest,
  warnTerrier,
} from "../here.ts";
import { emit, note, out, Output, renderTable, styles } from "../output.ts";
import { pluralize } from "@shigomori/contracts/words";
import { pickProject } from "../pickers.ts";
import { reporter } from "../reporter.ts";
import { confirm, interactive } from "../prompt.ts";
import { configVerbs, type Settings } from "./config.ts";
import { carryOverVerb } from "./configLists.ts";
import { cloneProject } from "./transfer.ts";

const refreshIconsFlag = Flag.Boolean("refresh-icons").pipe(
  Flag.withDefault(false),
);

const list = Command.make(
  "list",
  { refreshIcons: refreshIconsFlag, rest },
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
);

const icon = Command.make(
  "icon",
  {
    ...projectFlags,
    name: Argument.String("project").pipe(Argument.optional),
    rest,
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
);

// A project's settings, by the flags that name it.
const settingsFor = (flags: Parameters<typeof resolveProject>[0]) =>
  Effect.gen(function* () {
    const project = yield* resolveProject(flags);
    const settings: Settings = {
      scope: { kind: "project", projectId: project.id, path: project.path },
      project: project.name,
      listCommand: "projects config list",
      descriptions: keyDescriptions(ShigomoriConfigSchema),
    };
    return { settings, project };
  });

// The shorthand flags that set the scripts and the default branch:
// before any verb, and not together with one.
const shorthandFlags = {
  setup: Flag.String("setup").pipe(Flag.optional),
  teardown: Flag.String("teardown").pipe(Flag.optional),
  defaultBranch: Flag.String("default-branch").pipe(Flag.optional),
};

// A script flag as the patch takes it: none untouched, an empty one
// cleared.
const script = (flag: Option.Option<string>) =>
  Option.match(flag, {
    onNone: () => ({}),
    onSome: (value) => ({ value: value === "" ? null : value }),
  });

// The project settings' parent. -p and --project-id go before or after
// the verb. With no verb it prints the settings as stored, or with the
// flags sets them.
const settingsOf = Command.make("config", shorthandFlags, (input) =>
  Effect.gen(function* () {
    // The shared flags reach the parent's handler too, untyped there.
    const { settings, project } = yield* settingsFor(
      input as typeof input & Parameters<typeof resolveProject>[0],
    );
    const config = yield* Config.Config;
    const { json, stdoutColor } = yield* Effect.service(Output);
    const updates = [
      ["defaultBranch", input.defaultBranch],
      ["scripts.setup", input.setup],
      ["scripts.teardown", input.teardown],
    ] as const;
    if (updates.every(([, flag]) => Option.isNone(flag))) {
      const stored = yield* config.read(settings.scope);
      if (json) return yield* emit(stored);
      return yield* stored === null
        ? note(`No config for ${project.name} yet.`)
        : out(JSON.stringify(stored, null, 2));
    }
    if (Option.exists(input.defaultBranch, (ref) => ref.trim() === "")) {
      return yield* new UsageError({
        problem:
          "--default-branch can't be empty: it's required, so set a ref instead of clearing it.",
      });
    }
    // In one commit.
    const setup = script(input.setup);
    const teardown = script(input.teardown);
    yield* config.patchProject(
      { kind: "project", projectId: project.id, path: project.path },
      {
        ...Option.match(input.defaultBranch, {
          onNone: () => ({}),
          onSome: (defaultBranch) => ({ defaultBranch }),
        }),
        ...("value" in setup ? { "scripts.setup": setup.value } : {}),
        ...("value" in teardown ? { "scripts.teardown": teardown.value } : {}),
      },
    );
    yield* json
      ? emit({ ok: true, project: project.name })
      : out(styles(stdoutColor).green(`configured ${project.name}`));
  }),
).pipe(Command.withSharedFlags(projectFlags));

const projectSettings = Effect.flatMap(settingsOf, settingsFor);

const projectConfig = settingsOf.pipe(
  Command.withSubcommands([
    ...configVerbs(Effect.map(projectSettings, ({ settings }) => settings)),
    carryOverVerb(projectSettings),
  ]),
);

const yesFlag = Flag.Boolean("yes").pipe(
  Flag.withAlias("y"),
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
const addAll = (root: string, yes: boolean, terrier: boolean | undefined) =>
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
      const project = yield* projects
        .register(repo, { terrier })
        .pipe(Effect.result);
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
    rest,
    all: Flag.Boolean("all").pipe(Flag.withAlias("a"), Flag.withDefault(false)),
    terrier: Flag.Boolean("terrier").pipe(Flag.optional),
    yes: yesFlag,
  },
  (input) =>
    Effect.gen(function* () {
      yield* warnTerrier;
      const at = yield* absolute(input.path);
      const terrier = Option.getOrUndefined(input.terrier);
      if (input.all) return yield* addAll(at, input.yes, terrier);
      const project = yield* (yield* Projects.Projects).add(at, { terrier });
      const { json } = yield* Effect.service(Output);
      yield* json ? emit(project) : announce(project);
    }),
);

const unregisterArgs = {
  name: Argument.String("project").pipe(Argument.optional),
  rest,
  projectId: projectFlags.projectId,
  yes: yesFlag,
};

// The project the verb names, once confirmed: the question is asked of
// what removing it would leave.
const confirmedProject = (
  input: Command.Command.Config.Infer<typeof unregisterArgs>,
  verb: string,
  question: (
    project: Registry.ListedProject,
    left: Projects.Leftovers,
  ) => string,
) =>
  Effect.gen(function* () {
    const worktrees = yield* Worktrees.Worktrees;
    const { binaryName } = yield* Effect.service(Output);
    const at = yield* here;
    const projectId = given(input.projectId);
    const project = Option.isSome(projectId)
      ? yield* worktrees.resolveProjectById(at, projectId.value)
      : Option.isSome(input.name)
        ? yield* worktrees.resolveProject(at, input.name.value)
        : (yield* interactive)
          ? yield* pickProject(at)
          : yield* new UsageError({
              problem: `Specify a project to ${verb} (see \`${binaryName} projects list\`).`,
            });
    if (input.yes) return project;
    const left = yield* (yield* Projects.Projects).leftovers(project);
    if (!(yield* interactive)) {
      return yield* new UsageError({
        problem: `Refusing to ${verb} ${project.name} without confirmation. Re-run with --yes, or interactively.`,
      });
    }
    const terrier = left.inTerrier
      ? " It's unregistered from terrier too."
      : "";
    if (!(yield* confirm(question(project, left) + terrier))) {
      return yield* new Cancelled();
    }
    return project;
  });

const unregister = Command.make("unregister", unregisterArgs, (input) =>
  Effect.gen(function* () {
    const project = yield* confirmedProject(
      input,
      "unregister",
      (it, left) =>
        `Unregister ${it.name} (${it.path})? ` +
        (left.worktrees > 0
          ? `Its ${pluralize(left.worktrees, "worktree")} stay on disk.`
          : "No files are deleted from disk."),
    );
    yield* (yield* Projects.Projects).remove(project);
    const { json } = yield* Effect.service(Output);
    yield* json
      ? emit({ ok: true, unregistered: project.name, path: project.path })
      : out(`unregistered ${project.name} (${project.path})`);
  }),
).pipe(changing);

const deleteProject = Command.make("delete", unregisterArgs, (input) =>
  Effect.gen(function* () {
    const project = yield* confirmedProject(
      input,
      "delete",
      (it, left) =>
        `Delete ${it.name} (${it.path})` +
        (left.worktrees > 0
          ? ` and its ${pluralize(left.worktrees, "worktree")}`
          : "") +
        " from disk?",
    );
    yield* (yield* Projects.Projects).removeWithFiles(
      project,
      yield* reporter(),
    );
    const { json } = yield* Effect.service(Output);
    yield* json
      ? emit({ ok: true, deleted: project.name, path: project.path })
      : out(`deleted ${project.name} (${project.path})`);
  }),
).pipe(changing);

// For a repo moved or renamed by hand: the last positional is where it
// is now, the project before it.
const relocate = Command.make(
  "relocate",
  {
    projectId: projectFlags.projectId,
    args: Argument.String("args").pipe(Argument.variadic()),
  },
  (input) =>
    Effect.gen(function* () {
      const { json, binaryName, stdoutColor } = yield* Effect.service(Output);
      const most = Option.isSome(given(input.projectId)) ? 0 : 1;
      const count = input.args.length;
      if (count === 0 || count - 1 > most) {
        return yield* new UsageError({
          problem: `Usage: ${binaryName} projects relocate [<name-or-path>] <new-path>`,
        });
      }
      const destination = yield* absolute(input.args[count - 1] ?? "");
      const project = yield* resolveProject({
        projectId: input.projectId,
        project: Option.fromNullishOr(count > 1 ? input.args[0] : undefined),
      });
      const row = yield* (yield* Worktrees.Worktrees).relocateProject(
        project,
        destination,
      );
      yield* json
        ? emit({ ok: true, project: row })
        : out(
            styles(stdoutColor).green(`relocated ${row.name} to ${row.path}`),
          );
    }),
).pipe(changing);

export const projectsCommand = Command.make("projects").pipe(
  Command.withSubcommands([
    list,
    add,
    cloneProject,
    unregister,
    deleteProject,
    relocate,
    icon,
    projectConfig,
  ]),
);
