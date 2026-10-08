// sm [worktrees] <list|path|destination>: the worktrees, and where one
// is or would go.
import { messageOf } from "@shigomori/engine/errorDocument";
import * as Worktrees from "@shigomori/engine/Worktrees";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import { UsageError } from "../errors.ts";
import {
  given,
  here,
  projectFlags,
  resolveProject,
  resolveWorktree,
  worktreeFlags,
} from "../here.ts";
import { emit, note, out, Output, renderTable, styles } from "../output.ts";

type Styles = ReturnType<typeof styles>;

// A title cut to fit a terminal line.
const truncate = (text: string, max: number) => {
  const chars = [...text];
  return max < 2 || chars.length <= max
    ? text
    : `${chars.slice(0, max - 1).join("")}…`;
};

// The ↑ahead ↓behind cell, "synced" with no divergence.
const syncCell = (paint: Styles, row: Worktrees.WorktreeRow) => {
  if (row.detached) return paint.yellow("detached");
  if (!row.hasUpstream) return paint.dim("local");
  if (row.ahead === 0 && row.behind === 0) return paint.green("synced");
  return [
    row.ahead > 0 ? paint.cyan(`↑${row.ahead}`) : "",
    row.behind > 0 ? paint.yellow(`↓${row.behind}`) : "",
  ]
    .filter((part) => part !== "")
    .join(" ");
};

const changesCell = (paint: Styles, row: Worktrees.WorktreeRow) =>
  row.changedCount > 0
    ? paint.yellow(`${row.changedCount} changed`)
    : paint.dim("clean");

// Primary before external, and never both.
const flagsCell = (
  paint: Styles,
  row: {
    readonly isPrimary: boolean;
    readonly isExternal: boolean;
    readonly shelved: boolean;
    readonly autoPull: boolean;
    readonly agentWorking: boolean;
  },
) =>
  paint.dim(
    [
      row.isPrimary ? "primary" : row.isExternal ? "external" : "",
      row.shelved ? "shelved" : "",
      row.autoPull ? "auto-pull" : "",
      row.agentWorking ? "agent working" : "",
    ]
      .filter((flag) => flag !== "")
      .join(", "),
  );

// The projects a listing covers: the one --project-id or -p names, the
// one at the cwd, or with --all (or outside any) every project.
const scopeOf = (input: {
  readonly project: Option.Option<string>;
  readonly projectId: Option.Option<string>;
  readonly all: boolean;
}) =>
  Effect.gen(function* () {
    const worktrees = yield* Worktrees.Worktrees;
    const at = yield* here;
    const projectId = given(input.projectId);
    if (at.projects.length === 0 && Option.isNone(projectId)) {
      return yield* new NoProjects();
    }
    if (Option.isSome(projectId)) {
      return {
        at,
        scope: [yield* worktrees.resolveProjectById(at, projectId.value)],
      };
    }
    const project = given(input.project);
    if (!input.all && (Option.isSome(project) || at.current !== undefined)) {
      return {
        at,
        scope: [
          yield* worktrees.resolveProject(at, Option.getOrUndefined(project)),
        ],
      };
    }
    return { at, scope: at.projects };
  });

class NoProjects extends Schema.TaggedError<NoProjects>()("NoProjects", {}) {
  override get message(): string {
    return "No projects are registered yet. Add a repo in the Shigoto no Mori app first.";
  }
}

// A project the listing couldn't read, said and skipped.
const warnSkipped = (skipped: Worktrees.Listing<unknown>["skipped"]) =>
  Effect.forEach(skipped, ({ project, error }) =>
    note(`warning: skipping ${project.name}: ${messageOf(error)}`),
  );

const list = Command.make(
  "list",
  {
    ...worktreeFlags,
    all: Flag.Boolean("all").pipe(
      Flag.withAlias("a"),
      Flag.withDescription("Every project's worktrees"),
      Flag.withDefault(false),
    ),
    identities: Flag.Boolean("identities").pipe(
      Flag.withDescription("Which worktrees exist, without probing each"),
      Flag.withDefault(false),
    ),
    primaryRef: Flag.Boolean("primary-ref").pipe(
      Flag.withDescription("With --identities, each project's primary ref"),
      Flag.withDefault(false),
    ),
  },
  (input) =>
    Effect.gen(function* () {
      if (input.primaryRef && !input.identities) {
        return yield* new UsageError({
          problem:
            "--primary-ref only applies to --identities (full rows always carry primaryRef).",
        });
      }
      const worktrees = yield* Worktrees.Worktrees;
      const { json, stdoutColor } = yield* Effect.service(Output);
      const paint = styles(stdoutColor);
      const options = { primaryRef: input.primaryRef };

      // One worktree, as the app asks after changing it.
      if (Option.isSome(given(input.worktreeId))) {
        const { located } = yield* resolveWorktree({
          ...input,
          ref: Option.none(),
        });
        if (input.identities) {
          const row = yield* worktrees.identityRow(located, options);
          return yield* json
            ? emit([row])
            : identityTable(paint, [row], {
                names: new Map(),
                multi: false,
                current: "",
              });
        }
        const row = yield* worktrees.row(located, { settle: true });
        if (json) return yield* emit([row]);
        return yield* out(
          renderTable(
            ["NAME", "BRANCH", "SYNC", "CHANGES", "", "TITLE"],
            [
              [
                row.name,
                row.branch,
                syncCell(paint, row),
                changesCell(paint, row),
                flagsCell(paint, row),
                truncate(row.title ?? "", 50),
              ],
            ],
            stdoutColor,
          ),
        );
      }

      const { at, scope } = yield* scopeOf(input);
      const current = at.current?.worktree.id ?? "";
      if (input.identities) {
        const listing = yield* worktrees.identityList(scope, options);
        yield* warnSkipped(listing.skipped);
        if (json) return yield* emit(listing.rows);
        return yield* identityTable(paint, listing.rows, {
          names: new Map(scope.map((project) => [project.id, project.name])),
          multi: scope.length - listing.skipped.length > 1,
          current,
        });
      }
      const listing = yield* worktrees.list(scope);
      yield* warnSkipped(listing.skipped);
      if (json) return yield* emit(listing.rows);
      if (listing.rows.length === 0) return yield* note("No worktrees found.");
      // A project column once more than one project listed.
      const multi = scope.length - listing.skipped.length > 1;
      const rows = listing.rows.map((row) =>
        [row.id === current ? paint.cyan("@") : ""].concat(
          multi ? [row.projectName] : [],
          [
            row.name,
            row.branch,
            syncCell(paint, row),
            changesCell(paint, row),
            flagsCell(paint, row),
            truncate(row.title ?? "", 50),
          ],
        ),
      );
      yield* out(
        renderTable(
          multi
            ? ["", "PROJECT", "NAME", "BRANCH", "SYNC", "CHANGES", "", "TITLE"]
            : ["", "NAME", "BRANCH", "SYNC", "CHANGES", "", "TITLE"],
          rows,
          stdoutColor,
        ),
      );
    }),
).pipe(Command.withDescription("The worktrees, with their sync and changes"));

// The --identities table: NAME, BRANCH and the flags.
const identityTable = (
  paint: Styles,
  rows: ReadonlyArray<Worktrees.IdentityRow>,
  table: {
    readonly names: ReadonlyMap<string, string>;
    readonly multi: boolean;
    readonly current: string;
  },
) =>
  Effect.gen(function* () {
    if (rows.length === 0) return yield* note("No worktrees found.");
    const { names, multi, current } = table;
    const { stdoutColor } = yield* Effect.service(Output);
    yield* out(
      renderTable(
        multi
          ? ["", "PROJECT", "NAME", "BRANCH", ""]
          : ["", "NAME", "BRANCH", ""],
        rows.map((row) =>
          [row.id === current ? paint.cyan("@") : ""].concat(
            multi ? [names.get(row.projectId) ?? ""] : [],
            [row.name, row.branch, flagsCell(paint, row)],
          ),
        ),
        stdoutColor,
      ),
    );
  });

const path = Command.make(
  "path",
  {
    ...worktreeFlags,
    ref: Argument.String("worktree").pipe(Argument.optional),
  },
  (input) =>
    Effect.gen(function* () {
      const { located } = yield* resolveWorktree(input);
      const { worktree, project } = located;
      const { json } = yield* Effect.service(Output);
      yield* json
        ? emit({
            id: worktree.id,
            name: worktree.name,
            branch: worktree.branch,
            path: worktree.path,
            projectName: project.name,
            projectId: project.id,
            isPrimary: worktree.isPrimary,
          })
        : out(worktree.path);
    }),
).pipe(Command.withDescription("Print a worktree's folder"));

const destination = Command.make(
  "destination",
  {
    ...projectFlags,
    name: Flag.String("name").pipe(Flag.optional),
    rest: Argument.String("args").pipe(Argument.variadic()),
  },
  (input) =>
    Effect.gen(function* () {
      const { binaryName, json, stdoutColor } = yield* Effect.service(Output);
      if (input.rest.length > 0) {
        return yield* new UsageError({
          problem: `Usage: ${binaryName} worktrees destination [-p <project>] [--name <name>]`,
        });
      }
      const project = yield* resolveProject(input);
      const dest = yield* (yield* Worktrees.Worktrees).destination(
        project,
        Option.getOrElse(input.name, () => "").trim(),
      );
      yield* json
        ? emit({ ok: true, ...dest })
        : out(
            dest.taken
              ? `${dest.path}${styles(stdoutColor).dim(" (taken)")}`
              : dest.path,
          );
    }),
).pipe(Command.withDescription("Where a new worktree would go"));

// The verbs stand at the top level and under `sm worktrees`.
export { destination, list, path };

export const worktreesCommand = Command.make("worktrees").pipe(
  Command.withDescription("Worktree commands (the prefix is optional)"),
  Command.withSubcommands([list, path, destination]),
);
