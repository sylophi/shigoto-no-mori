// Single chokepoint for every git invocation. Other modules in this
// folder call `run` / `runLenient`; nothing else in the codebase should
// shell out to git directly.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Context, Data, Effect, Layer } from "effect";

const execFileP = promisify(execFile);

interface GitExecResult {
  stdout: string;
  stderr: string;
}

interface ExecFileError extends Error {
  code?: number | string;
  signal?: NodeJS.Signals;
  stdout?: string;
  stderr?: string;
}

export class GitCommandError extends Data.TaggedError("GitCommandError")<{
  readonly args: string[];
  readonly cwd: string;
  readonly durationMs: number;
  readonly exitCode?: number | string;
  readonly signal?: NodeJS.Signals;
  readonly stdout: string;
  readonly stderr: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    const command = `git ${this.args.join(" ")}`;
    const detail = this.stderr.trim() || this.stdout.trim();
    return detail ? `${command} failed: ${detail}` : `${command} failed`;
  }
}

export function isGitCommandError(error: unknown): error is GitCommandError {
  return error instanceof GitCommandError;
}

function execEffect(
  args: string[],
  options: { cwd: string; maxBuffer?: number },
) {
  const start = performance.now();
  return Effect.tryPromise({
    try: async (): Promise<GitExecResult> => {
      const result = await execFileP("git", args, options);
      return { stdout: result.stdout, stderr: result.stderr };
    },
    catch: (err) => {
      const elapsed = Math.round(performance.now() - start);
      const execErr = err as ExecFileError;
      console.warn(`[git] ${args.join(" ")} FAIL (${elapsed}ms)`);
      return new GitCommandError({
        args,
        cwd: options.cwd,
        durationMs: elapsed,
        exitCode: execErr.code,
        signal: execErr.signal,
        stdout: execErr.stdout ?? "",
        stderr: execErr.stderr ?? "",
        cause: err,
      });
    },
  }).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        const elapsed = Math.round(performance.now() - start);
        console.log(`[git] ${args.join(" ")} (${elapsed}ms)`);
      }),
    ),
  );
}

async function exec(
  args: string[],
  options: { cwd: string; maxBuffer?: number },
): Promise<GitExecResult> {
  return Effect.runPromise(execEffect(args, options));
}

export function runEffect(cwd: string, args: string[]) {
  return execEffect(args, { cwd, maxBuffer: 10 * 1024 * 1024 }).pipe(
    Effect.map((result) => result.stdout),
  );
}

export class GitService extends Context.Tag("GitService")<
  GitService,
  {
    readonly run: (
      cwd: string,
      args: string[],
    ) => Effect.Effect<string, GitCommandError>;
    readonly runVoid: (
      cwd: string,
      args: string[],
    ) => Effect.Effect<void, GitCommandError>;
    readonly isRepo: (path: string) => Effect.Effect<boolean>;
  }
>() {}

export const GitServiceLive = Layer.succeed(GitService, {
  run: runEffect,
  runVoid: (cwd, args) => runEffect(cwd, args).pipe(Effect.asVoid),
  isRepo: (path) =>
    execEffect(["rev-parse", "--git-dir"], { cwd: path }).pipe(
      Effect.as(true),
      Effect.catchAll(() => Effect.succeed(false)),
    ),
});

export const Git = {
  run: (cwd: string, args: string[]) =>
    Effect.flatMap(GitService, (git) => git.run(cwd, args)),
  runVoid: (cwd: string, args: string[]) =>
    Effect.flatMap(GitService, (git) => git.runVoid(cwd, args)),
  isRepo: (path: string) =>
    Effect.flatMap(GitService, (git) => git.isRepo(path)),
};

export function runGitProgram<A, E>(
  effect: Effect.Effect<A, E, GitService>,
): Promise<A> {
  return Effect.runPromise(Effect.provide(effect, GitServiceLive));
}

export async function run(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec(args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

// Like `run`, but tolerates non-zero exit (e.g. `git diff --no-index`,
// which exits 1 whenever there's a diff to print). Returns whatever
// stdout was produced before exit, falling back to empty.
export async function runLenient(cwd: string, args: string[]): Promise<string> {
  try {
    return await run(cwd, args);
  } catch (err) {
    if (isGitCommandError(err)) return err.stdout;
    return (err as { stdout?: string }).stdout ?? "";
  }
}

export async function isGitRepo(path: string): Promise<boolean> {
  return runGitProgram(Git.isRepo(path));
}
