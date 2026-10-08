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
import {
  emit,
  note,
  out,
  Output,
  renderTable,
  styles,
  type Styles,
} from "../output.ts";
import { divergenceCell, flagNames, truncate } from "./cells.ts";
import { describe } from "./describe.ts";
import { agentWorking, autopull, shelve, unshelve } from "./marks.ts";
import { status } from "./status.ts";

// A title cut to fit a terminal line.
const titleCell = (title: string | undefined) => truncate(title ?? "", 50);

const syncCell = (paint: Styles, row: Worktrees.WorktreeRow) =>
  row.detached
    ? paint.yellow("detached")
    : row.hasUpstream
      ? divergenceCell(paint, row.ahead, row.behind, "synced")
      : paint.dim("local");

const changesCell = (paint: Styles, row: Worktrees.WorktreeRow) =>
  row.changedCount > 0
    ? paint.yellow(`${row.changedCount} changed`)
    : paint.dim("clean");

const flagsCell = (paint: Styles, row: Parameters<typeof flagNames>[0]) =>
  paint.dim(flagNames(row).join(", "));

class NoProjects extends Schema.TaggedError<NoProjects>()("NoProjects", {}) {
  override get message(): string {
    return "No projects are registered yet. Add a repo in the Shigoto no Mori app first.";
  }
}

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
    remote: Flag.Boolean("remote").pipe(
      Flag.withDescription("Another device's worktrees (not yet)"),
      Flag.withDefault(false),
    ),
    from: Flag.String("from").pipe(Flag.optional),
    // Go lets positionals be.
    rest: Argument.String("args").pipe(Argument.variadic()),
  },
  (input) =>
    Effect.gen(function* () {
      if (input.remote || Option.isSome(given(input.from))) {
        return yield* new UsageError({
          problem:
            "--remote and --from list another device's worktrees, which this build can't yet.",
        });
      }
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

      // One worktree, as the app asks after changing it. Its full row
      // has no marker column, as in Go.
      if (Option.isSome(given(input.worktreeId))) {
        const { at, located } = yield* resolveWorktree(input);
        if (input.identities) {
          const row = yield* worktrees.identityRow(located, options);
          return yield* json
            ? emit([row])
            : identityTable(paint, [row], {
                names: new Map(),
                multi: false,
                current: at.current?.worktree.id ?? "",
              });
        }
        const row = yield* worktrees.row(located, { settle: true });
        return yield* json
          ? emit([row])
          : rowTable(paint, [row], { multi: false });
      }

      const { at, scope } = yield* scopeOf(input);
      const current = at.current?.worktree.id ?? "";
      // A project column once more than one project listed.
      const listed = (skipped: Worktrees.Listing<unknown>["skipped"]) =>
        scope.length - skipped.length > 1;
      if (input.identities) {
        const listing = yield* worktrees.identityList(scope, options);
        yield* warnSkipped(listing.skipped);
        if (json) return yield* emit(listing.rows);
        return yield* identityTable(paint, listing.rows, {
          names: new Map(scope.map((project) => [project.id, project.name])),
          multi: listed(listing.skipped),
          current,
        });
      }
      const listing = yield* worktrees.list(scope);
      yield* warnSkipped(listing.skipped);
      if (json) return yield* emit(listing.rows);
      yield* rowTable(paint, listing.rows, {
        multi: listed(listing.skipped),
        current,
      });
    }),
).pipe(Command.withDescription("The worktrees, with their sync and changes"));

// The full table: sync, changes, flags and title, with the marker
// column (`@` at the cwd's worktree) when there is a cwd to mark.
const rowTable = (
  paint: Styles,
  rows: ReadonlyArray<Worktrees.WorktreeRow>,
  table: { readonly multi: boolean; readonly current?: string },
) =>
  Effect.flatMap(Effect.service(Output), ({ stdoutColor }) => {
    if (rows.length === 0) return note("No worktrees found.");
    const marked = table.current !== undefined;
    return out(
      renderTable(
        (marked ? [""] : []).concat(table.multi ? ["PROJECT"] : [], [
          "NAME",
          "BRANCH",
          "SYNC",
          "CHANGES",
          "",
          "TITLE",
        ]),
        rows.map((row) =>
          (marked
            ? [row.id === table.current ? paint.cyan("@") : ""]
            : []
          ).concat(table.multi ? [row.projectName] : [], [
            row.name,
            row.branch,
            syncCell(paint, row),
            changesCell(paint, row),
            flagsCell(paint, row),
            titleCell(row.title),
          ]),
        ),
        stdoutColor,
      ),
    );
  });

// The --identities table: NAME, BRANCH and the flags.
const identityTable = (
  paint: Styles,
  rows: ReadonlyArray<Worktrees.IdentityRow>,
  table: {
    readonly names: ReadonlyMap<string, string>;
    readonly multi: boolean;
    readonly current?: string;
  },
) =>
  Effect.gen(function* () {
    if (rows.length === 0) return yield* note("No worktrees found.");
    const { stdoutColor } = yield* Effect.service(Output);
    yield* out(
      renderTable(
        [""].concat(table.multi ? ["PROJECT"] : [], ["NAME", "BRANCH", ""]),
        rows.map((row) =>
          [row.id === table.current ? paint.cyan("@") : ""].concat(
            table.multi ? [table.names.get(row.projectId) ?? ""] : [],
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
    // Go reads the first and lets the rest be.
    rest: Argument.String("args").pipe(Argument.variadic()),
  },
  (input) =>
    Effect.gen(function* () {
      const { worktree, project } = (yield* resolveWorktree(input)).located;
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
      const worktrees = yield* Worktrees.Worktrees;
      const dest = yield* worktrees.destination(
        project,
        Option.getOrElse(input.name, () => ""),
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
  Command.withSubcommands([
    list,
    path,
    destination,
    status,
    describe,
    shelve,
    unshelve,
    autopull,
    agentWorking,
  ]),
);
