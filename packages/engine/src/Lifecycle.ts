// The lifecycle scripts a worktree runs as it is made and removed: the
// project's setup and teardown, and port-pool's provision and release.
// Each runs to its end in the user's login shell, in the worktree, with
// the SHIGOMORI_* variables (packages/contracts scriptEnv) and the
// unattended-run settings, and every step is reported as the document
// `sm --json` prints for it, so the terminal and the host relay the same
// events.
import type {
  LifecycleSlot,
  ScriptEvent,
} from "@shigomori/contracts/schemas/scripts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ConfigService from "./Config.ts";
import { findExecutable } from "./executables.ts";
import { parsePortPoolConfig, PORT_POOL_CONFIG } from "./ports.ts";

// Where a lifecycle step stands, as `sm --json` reports it.
export type Phase = "carryOver" | "setup" | "portPoolProvision" | "idle";

// One event of a lifecycle run, as the document `sm --json` prints.
export type LifecycleEvent =
  | { readonly event: "phase"; readonly phase: Phase }
  | ({ readonly event: "script" } & ScriptEvent);

// Where a report of the run's events goes.
export type Report = (event: LifecycleEvent) => Effect.Effect<void>;

// A script that didn't finish cleanly: its step and exit code, null
// when it never ran or died to a signal.
export type ScriptFailure = {
  readonly step: string;
  readonly exitCode: number | null;
};

// What a script is told about the worktree it runs in.
export type ScriptContext = {
  readonly project: {
    readonly id: string;
    readonly name: string;
    readonly path: string;
  };
  readonly worktree: {
    readonly id: string;
    readonly name: string;
    readonly branch: string;
    readonly path: string;
    readonly isExternal: boolean;
  };
  // The primary checkout's branch, empty for a bare repo.
  readonly projectBranch: string;
  // The project's primary ref.
  readonly defaultBranch: string;
  // What `sm describe` set, as stored.
  readonly title: string;
  readonly description: string;
};

export class Lifecycle extends Context.Service<
  Lifecycle,
  {
    // Runs one script to its end, reporting it, and answers its exit
    // code (null when it never ran or died to a signal) and its run id.
    // `color` asks for truecolor output, for a run the app's console
    // shows.
    readonly run: (input: {
      readonly command: string;
      readonly slot: LifecycleSlot;
      readonly context: ScriptContext;
      readonly color: boolean;
      readonly report: Report;
    }) => Effect.Effect<{
      readonly code: number | null;
      readonly runId: string;
    }>;
    // Whether port-pool provisions and releases this worktree: the device
    // setting is on, port-pool is installed, the worktree is configured
    // for it, and the app made the worktree (no provision ever ran for an
    // external one, so none is released either).
    readonly portPoolActive: (worktree: {
      readonly path: string;
      readonly isExternal: boolean;
    }) => Effect.Effect<boolean>;
  }
>()("sm/engine/Lifecycle") {}

// The variables a run's identity travels in. A stale one from a parent
// run is dropped first, so a script that runs sm can't leak it.
const CONTRACT_KEYS = [
  "SHIGOMORI_SCRIPT_NAME",
  "SHIGOMORI_WORKTREE_PATH",
  "SHIGOMORI_WORKTREE_NAME",
  "SHIGOMORI_WORKTREE_BRANCH",
  "SHIGOMORI_WORKTREE_ID",
  "SHIGOMORI_WORKTREE_TITLE",
  "SHIGOMORI_WORKTREE_DESCRIPTION",
  "SHIGOMORI_PROJECT_PATH",
  "SHIGOMORI_PROJECT_NAME",
  "SHIGOMORI_PROJECT_BRANCH",
  "SHIGOMORI_DEFAULT_BRANCH",
] as const;

// The name a slot's script goes by in SHIGOMORI_SCRIPT_NAME.
const scriptName = (slot: LifecycleSlot) =>
  slot.kind === "portPool" ? `port-pool-${slot.phase}` : slot.kind;

// A single-quoted shell word.
export const shellQuote = (text: string) =>
  `'${text.replaceAll("'", `'\\''`)}'`;

const decoder = new TextDecoder();

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ConfigService.Config;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

  // The user's login shell, run as one (no -i) so .zprofile sets PATH up
  // without zsh's interactive init. $SHELL first, then the account
  // database, which is the GUI case: a process launchd started may carry
  // no $SHELL at all. /bin/sh only when neither names one.
  const accountShell = spawner
    .string(
      ChildProcess.make("/bin/sh", [
        "-c",
        `dscl . -read "/Users/$(id -un)" UserShell 2>/dev/null || getent passwd "$(id -u)" | cut -d: -f7`,
      ]),
    )
    .pipe(
      Effect.map((out) => out.replace(/^UserShell:/, "").trim()),
      Effect.orElseSucceed(() => ""),
    );
  const loginShell = yield* Effect.cached(
    Effect.gen(function* () {
      const shell = yield* Config.String("SHELL").pipe(
        Effect.orElseSucceed(() => ""),
      );
      const found = shell !== "" ? shell : yield* accountShell;
      return found === ""
        ? { shell: "/bin/sh", args: ["-c"] }
        : { shell: found, args: ["-l", "-c"] };
    }),
  );

  const run = Effect.fn("Lifecycle.run")(function* (input: {
    readonly command: string;
    readonly slot: LifecycleSlot;
    readonly context: ScriptContext;
    readonly color: boolean;
    readonly report: Report;
  }) {
    const { context, slot, report } = input;
    const runId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const script = (event: ScriptEvent) =>
      report({ event: "script", ...event } as LifecycleEvent);
    const started = (pid?: number) =>
      script({
        runId,
        kind: "started",
        projectId: context.project.id,
        worktreeId: context.worktree.id,
        slot,
        ...(pid === undefined ? {} : { pid }),
      });
    const exit = (code: number | null) =>
      script({ runId, kind: "exit", code }).pipe(Effect.as({ code, runId }));
    const contract: Record<(typeof CONTRACT_KEYS)[number], string> = {
      SHIGOMORI_SCRIPT_NAME: scriptName(slot),
      SHIGOMORI_WORKTREE_PATH: context.worktree.path,
      SHIGOMORI_WORKTREE_NAME: context.worktree.name,
      SHIGOMORI_WORKTREE_BRANCH: context.worktree.branch,
      SHIGOMORI_WORKTREE_ID: context.worktree.id,
      SHIGOMORI_WORKTREE_TITLE: context.title,
      SHIGOMORI_WORKTREE_DESCRIPTION: context.description,
      SHIGOMORI_PROJECT_PATH: context.project.path,
      SHIGOMORI_PROJECT_NAME: context.project.name,
      SHIGOMORI_PROJECT_BRANCH: context.projectBranch,
      SHIGOMORI_DEFAULT_BRANCH: context.defaultBranch,
    };
    const { shell, args } = yield* loginShell;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner
          .spawn(
            ChildProcess.make(shell, [...args, input.command], {
              cwd: context.worktree.path,
              extendEnv: true,
              env: {
                // A script that runs `sm cd` must not retarget the
                // wrapper's directive file.
                SHIGOMORI_CD_FILE: undefined,
                // exec refuses an environment holding a NUL, and the
                // description is free text.
                ...Object.fromEntries(
                  CONTRACT_KEYS.map((key) => [
                    key,
                    contract[key].replaceAll("\0", ""),
                  ]),
                ),
                // Output goes to a pipe, so tools are told it's a color
                // terminal, and nobody is there to page.
                FORCE_COLOR: "1",
                TERM: "xterm-256color",
                COLUMNS: "120",
                PAGER: "cat",
                GIT_PAGER: "cat",
                ...(input.color ? { COLORTERM: "truecolor" } : {}),
              },
              stdin: "ignore",
            }),
          )
          .pipe(Effect.result);
        if (Result.isFailure(handle)) {
          yield* started();
          yield* script({
            runId,
            kind: "error",
            data: String(handle.failure.cause ?? handle.failure.message),
          });
          return yield* exit(null);
        }
        // Started before any output is read, so it comes first.
        yield* started(handle.success.pid);
        yield* handle.success.all.pipe(
          Stream.runForEach((chunk) =>
            script({ runId, kind: "data", data: decoder.decode(chunk) }),
          ),
          Effect.ignore,
        );
        // A signal death is no exit code, like a run that never started.
        const code = yield* handle.success.exitCode.pipe(
          Effect.map(Number),
          Effect.orElseSucceed(() => null),
        );
        return yield* exit(code);
      }),
    );
  });

  const portPoolActive = Effect.fn("Lifecycle.portPoolActive")(
    function* (worktree: {
      readonly path: string;
      readonly isExternal: boolean;
    }) {
      if (worktree.isExternal) return false;
      const enabled = yield* config.get({ kind: "device" }, "portPool").pipe(
        Effect.map((setting) => setting.value === true),
        Effect.orElseSucceed(() => false),
      );
      if (!enabled) return false;
      const installed = yield* findExecutable("port-pool").pipe(
        Effect.map(Option.isSome),
        Effect.provideContext(platform),
      );
      if (!installed) return false;
      return yield* fs
        .readFileString(path.join(worktree.path, PORT_POOL_CONFIG))
        .pipe(
          Effect.map((text) => parsePortPoolConfig(text).configured),
          Effect.orElseSucceed(() => false),
        );
    },
  );

  return Lifecycle.of({ run, portPoolActive });
});

export const layer = Layer.effect(Lifecycle, make);
