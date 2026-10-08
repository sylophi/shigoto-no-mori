// sm run [<script> [args...]]: the package.json scripts of the worktree
// the cwd is in, listed, or one of them run by the manager its lockfile
// picks, with the SHIGOMORI_* variables, from the worktree's root. The
// app's scripts panel runs scripts the same way, by the ids it holds
// (--project-id, --worktree-id), and reads the list's --json.
//
// The script gets the terminal to itself (handOver.ts).
import * as Scripts from "@shigomori/engine/Scripts";
import { scriptEnv } from "@shigomori/engine/Lifecycle";
import * as Worktrees from "@shigomori/engine/Worktrees";
import { projectsHint } from "@shigomori/engine/Worktrees";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import { UsageError } from "../errors.ts";
import { handOver } from "../handOver.ts";
import { given, here } from "../here.ts";
import { alignRows, emit, note, out, Output, styles } from "../output.ts";

// Where the scripts are: the worktree the app names, else the one at
// the cwd. Running a script somewhere else is the scripts panel's job.
const target = (ids: {
  readonly projectId: Option.Option<string>;
  readonly worktreeId: Option.Option<string>;
}) =>
  Effect.gen(function* () {
    const worktrees = yield* Worktrees.Worktrees;
    const { binaryName } = yield* Effect.service(Output);
    const at = yield* here;
    const worktreeId = given(ids.worktreeId);
    if (Option.isSome(worktreeId)) {
      return yield* worktrees.resolve(at, {
        worktreeId: worktreeId.value,
        projectId: Option.getOrUndefined(given(ids.projectId)),
      });
    }
    if (at.current !== undefined) return at.current;
    if (at.unregisteredRepo !== undefined) {
      return yield* new UsageError({
        problem: `This repo (${at.unregisteredRepo}) isn't registered as a project. Register it with \`${binaryName} projects add\` to run scripts here.`,
      });
    }
    const hint = projectsHint(at.projects.map(({ name }) => name));
    return yield* new UsageError({
      problem: `\`${binaryName} run\` only works inside a registered project's checkout or worktree. ${hint}`,
    });
  });

export const runCommand = Command.make(
  "run",
  {
    projectId: Flag.String("project-id").pipe(Flag.optional),
    worktreeId: Flag.String("worktree-id").pipe(Flag.optional),
    args: Argument.String("script").pipe(Argument.variadic()),
  },
  (input) =>
    Effect.gen(function* () {
      const scripts = yield* Scripts.Scripts;
      const { json, binaryName, stdoutColor, stderrColor } =
        yield* Effect.service(Output);
      const { project, worktree } = yield* target(input);
      const [script, ...extra] = input.args;
      const listing = { projectId: project.id, worktreePath: worktree.path };
      if (script === undefined) {
        const listed = yield* scripts.list(listing);
        if (json) return yield* emit({ ok: true, ...listed });
        const dimErr = styles(stderrColor).dim;
        if (listed.scripts.length === 0) {
          return yield* note(dimErr("no scripts in package.json"));
        }
        const { cyan, dim } = styles(stdoutColor);
        for (const line of alignRows(
          listed.scripts.map(({ name, command }) => [cyan(name), dim(command)]),
        )) {
          yield* out(line);
        }
        return yield* note(
          dimErr(
            `runs with ${listed.packageManager}: \`${binaryName} run <script>\``,
          ),
        );
      }
      if (json) {
        // A package.json that can't be read says so first.
        yield* scripts.readScripts(worktree.path);
        return yield* new UsageError({
          problem: `\`${binaryName} run <script>\` hands the terminal to the script. --json only applies to the list form.`,
        });
      }
      const command = yield* scripts.command({ worktree, script, extra });
      const context = yield* (yield* Worktrees.Worktrees).scriptContext({
        project,
        worktree,
      });
      yield* scripts.recordRun(project.id, script);
      // From the worktree's root, not the cwd: a nested package.json must
      // not retarget the run.
      yield* handOver("exec", command.program, command.args, {
        cwd: worktree.path,
        env: { ...process.env, ...scriptEnv(context, script) },
      });
    }),
).pipe(Command.withDescription("List or run the worktree's package scripts"));
