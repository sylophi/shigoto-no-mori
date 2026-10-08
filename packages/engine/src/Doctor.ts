// `sm doctor`: why sm is behaving weirdly. It answers three questions
// the other commands can only fail at. Is this installation intact
// (git, gh, the app bundle behind the binary, PATH, the shell hook)? Is
// the data dir consistent (no lock a crashed process left behind, no
// project whose repo is gone, git's worktree metadata agreeing with the
// disk, launchers and carry-over naming things that exist)? And did a
// crash leave anything behind (a tunnel or dev server still running,
// update downloads, transfer refs)?
//
// The checks only read. A repair whose outcome is unambiguous rides on
// its finding and runs only when the caller asks for the fix: delete a
// stale lock, unregister a project whose repo is gone, re-link a moved
// worktree, `git worktree prune`. Anything with a judgment call in it is
// reported with a suggested fix and never touched. The document keeps
// the shape `sm doctor --json` prints, field for field.
import * as Clock from "effect/Clock";
import * as EffectConfig from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as CloneCheckout from "./CloneCheckout.ts";
import * as Config from "./Config.ts";
import { storedProblem } from "./Config.ts";
import type { ConfigDoc } from "./configDoc.ts";
import {
  atoi,
  belowGitFloor,
  fields,
  findHookSpan,
  fishHookContent,
  formatSize,
  hookBeginMarker,
  hookBlock,
  type HookNames,
  launcherProgram,
  newerThan,
  parseGitVersion,
  parsePortPoolDirs,
  parseProcessTable,
  parseSemver,
  plural,
  pluralize,
  scriptFileTokens,
  SHELL_KINDS,
  type ShellKind,
  shellWord,
} from "./doctorParse.ts";
import { findExecutable } from "./executables.ts";
import { flavorNames } from "./flavor.ts";
import * as Git from "./Git.ts";
import * as Layout from "./Layout.ts";
import * as Paths from "./Paths.ts";
import { STATE_FILES } from "./Paths.ts";
import { isAbsent, isNotFound } from "./platformErrors.ts";
import * as Registry from "./Registry.ts";
import type { ListedProject, RegisteredProject } from "./Registry.ts";
import * as Terrier from "./Terrier.ts";
import { terrierProjects } from "./Terrier.ts";
import * as WorktreeData from "./WorktreeData.ts";
import { worktreeIdFromPath } from "./worktreeLayout.ts";
import * as Worktrees from "./Worktrees.ts";
import type { WorktreeIdentity } from "./Worktrees.ts";

// --- the document ---------------------------------------------------------

export type Status = "ok" | "warn" | "fail";

// The groups in the order they print: broadest blast radius first.
const GROUPS = ["Environment", "Data dir", "Processes", "Projects"] as const;
export type Group = (typeof GROUPS)[number];

// One line of the checklist. `detail` explains it, `fix` suggests what
// to do (absent when there is nothing to suggest), and `repairable` says
// the fix can apply a repair for it.
export type Finding = {
  readonly group: Group;
  readonly id: string;
  readonly title: string;
  readonly status: Status;
  readonly detail: string;
  readonly fix?: string;
  readonly repairable?: true;
};

// A repair as the terminal asks about it: the yes/no question for a
// destructive one, and the past-tense line reported once it ran.
export type Repair = {
  readonly prompt: string;
  readonly label: string;
  readonly destructive: boolean;
};

export type DoctorDocument = {
  readonly ok: boolean;
  readonly dataDir: string;
  readonly flavor: string;
  readonly version: string;
  readonly binary: string;
  readonly summary: {
    readonly ok: number;
    readonly warn: number;
    readonly fail: number;
  };
  // The labels of the repairs that ran, and a "couldn't <label>: <why>"
  // line for each that failed.
  readonly repaired: ReadonlyArray<string>;
  readonly repairFailed: ReadonlyArray<string>;
  readonly checks: ReadonlyArray<Finding>;
};

// A moved worktree still waits to be re-linked, which a prune would
// sever.
export class MovedWorktreePending extends Schema.TaggedError<MovedWorktreePending>()(
  "MovedWorktreePending",
  { project: Schema.String },
) {
  override get message(): string {
    return `a moved worktree in ${this.project} needs re-linking first (\`git worktree repair <new path>\`)`;
  }
}

// A stager is downloading an update, and owns the files in updates/.
export class UpdateInProgress extends Schema.TaggedError<UpdateInProgress>()(
  "UpdateInProgress",
  { pid: Schema.Finite },
) {
  override get message(): string {
    return `Another update is already in progress (pid ${this.pid}).`;
  }
}

type RepairError =
  | Git.GitError
  | PlatformError.PlatformError
  | MovedWorktreePending
  | UpdateInProgress;

export class Doctor extends Context.Service<
  Doctor,
  {
    // Every check, in the order the checklist prints. With `fix`, the
    // repairs the findings offer run in that order, a destructive one
    // only once `approve` says yes, and the checks run again so the
    // document describes the world after them. A failed repair is
    // reported and the rest still run.
    readonly run: (input: {
      // This build's version, which the app bundle and the update files
      // are compared against.
      readonly version: string;
      // The running binary, which a prod build expects inside the app.
      readonly executable: string;
      // Whether a person is at a terminal, which makes a shell hook that
      // isn't active in this session worth a word.
      readonly terminal: boolean;
      readonly fix?: {
        readonly approve: (repair: Repair) => Effect.Effect<boolean>;
      };
    }) => Effect.Effect<DoctorDocument>;
  }
>()("sm/engine/Doctor") {}

// --- helpers --------------------------------------------------------------

type Entry = Finding & {
  readonly repair?: Repair & {
    readonly apply: Effect.Effect<void, RepairError>;
  };
};

const ok = (
  group: Group,
  id: string,
  title: string,
  detail: string,
): Entry => ({
  group,
  id,
  title,
  status: "ok",
  detail,
});

const warn = (
  group: Group,
  id: string,
  title: string,
  detail: string,
  fix: string,
): Entry => ({ group, id, title, status: "warn", detail, fix });

const fail = (
  group: Group,
  id: string,
  title: string,
  detail: string,
  fix: string,
): Entry => ({ group, id, title, status: "fail", detail, fix });

const repairable = (
  finding: Entry,
  repair: NonNullable<Entry["repair"]>,
): Entry => ({ ...finding, repairable: true, repair });

const counts = (entries: ReadonlyArray<Entry>) => ({
  ok: entries.filter(({ status }) => status === "ok").length,
  warn: entries.filter(({ status }) => status === "warn").length,
  fail: entries.filter(({ status }) => status === "fail").length,
});

// The finding as the document prints it, without its repair.
const findingOf = ({ repair: _, ...finding }: Entry): Finding => finding;

// What a failed repair says after "couldn't <label>: ".
const repairMessage = (error: RepairError) =>
  error instanceof Git.GitCommandError
    ? `git ${error.subcommand}: ${Git.stderrOf(error).trim()}`
    : error.message;

// A lock older than this belonged to a process that died holding it:
// the writes they guard take milliseconds.
const LOCK_STALE_MS = 10_000;
// A transfer's landing ref older than this can only be a leftover: a
// landing sweeps it within seconds.
const INCOMING_REF_STALE_MS = 60 * 60 * 1000;
// ps reports a start time to the second, stamped just after spawn.
const SCRIPT_START_TOLERANCE_MS = 5_000;

const APP_NAME = "Shigoto no Mori";
const WORKTREE_INCLUDE = ".worktreeinclude";
const INCOMING_PREFIX = "refs/shigomori/incoming/";

// running-scripts.json: the dev servers and scripts the app started,
// with the app instance that owns them.
const RunningScripts = Schema.fromJsonString(
  Schema.Struct({
    ownerPid: Schema.optional(Schema.Finite),
    scripts: Schema.optional(
      Schema.Array(
        Schema.Struct({
          pid: Schema.optional(Schema.Finite),
          startedAt: Schema.optional(Schema.Finite),
          command: Schema.optional(Schema.String),
        }),
      ),
    ),
  }),
);

// The update stager's manifest of what it staged.
const StagedManifest = Schema.fromJsonString(
  Schema.Struct({ version: Schema.optional(Schema.String) }),
);

// A project's stored settings, which count only once it has a default
// branch, as everything that reads them decides.
const configured = (doc: ConfigDoc | null) =>
  typeof doc?.["defaultBranch"] === "string" &&
  doc["defaultBranch"].trim() !== ""
    ? doc
    : null;

const textAt = (
  doc: Readonly<Record<string, unknown>> | null,
  key: string,
): string => {
  const value = doc?.[key];
  return typeof value === "string" ? value : "";
};

const scriptText = (settings: ConfigDoc | null, key: "setup" | "teardown") => {
  const scripts = settings?.["scripts"];
  return Predicate.isObject(scripts) ? textAt(scripts, key) : "";
};

const listOf = (doc: ConfigDoc | null, key: string) => {
  const value = doc?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is Readonly<Record<string, unknown>> =>
        Predicate.isObject(item),
      )
    : [];
};

const launcherCommands = (doc: ConfigDoc | null) =>
  listOf(doc, "launchers").map((entry) => ({
    label: textAt(entry, "label"),
    command: textAt(entry, "command"),
  }));

// An environment variable, empty when unset.
const env = (name: string) =>
  EffectConfig.String(name).pipe(Effect.orElseSucceed(() => ""));

const mtimeOf = (info: FileSystem.File.Info) =>
  Option.match(info.mtime, {
    onNone: () => 0,
    onSome: (date) => date.getTime(),
  });

const projectScope = (project: RegisteredProject) => ({
  kind: "project" as const,
  projectId: project.id,
  path: project.path,
});

// --- the service ----------------------------------------------------------

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const sql = yield* SqlClient.SqlClient;
  const paths = yield* Paths.Paths;
  const config = yield* Config.Config;
  const git = yield* Git.Git;
  const layout = yield* Layout.Layout;
  const registry = yield* Registry.Registry;
  const terrier = yield* Terrier.Terrier;
  const worktrees = yield* Worktrees.Worktrees;
  const data = yield* WorktreeData.WorktreeData;
  const cloneCheckout = yield* CloneCheckout.CloneCheckout;
  const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

  const { home, dataDir, binaryName, flavor } = paths;
  const names = flavorNames(flavor);
  const hookNames: HookNames = { binary: binaryName, alias: names.alias };
  // Read once, as Paths reads the environment.
  const xdgConfigHome = yield* env("XDG_CONFIG_HOME");
  const configHome =
    xdgConfigHome === "" ? path.join(home, ".config") : xdgConfigHome;
  const zdotdir = yield* env("ZDOTDIR");
  // The shell wrapper's directive file, set while the hook is active.
  const cdFile = yield* env("SHIGOMORI_CD_FILE");

  const collapseHome = (target: string) => {
    if (home === "") return target;
    if (target === home) return "~";
    return target.startsWith(`${home}/`)
      ? `~${target.slice(home.length)}`
      : target;
  };

  // A program's stdout and exit code. Fails when it can't be spawned.
  const capture = (
    command: string,
    args: ReadonlyArray<string>,
    options: {
      readonly cwd?: string;
      readonly env?: Record<string, string>;
    } = {},
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(command, [...args], {
            stdin: "ignore",
            ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
            ...(options.env === undefined
              ? {}
              : { env: options.env, extendEnv: true }),
          }),
        );
        const [stdout, , code] = yield* Effect.all(
          [
            handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
            Stream.runDrain(handle.stderr),
            handle.exitCode,
          ],
          { concurrency: 3 },
        );
        return { stdout, code: Number(code) };
      }),
    );

  // Whether a process with the pid exists, whoever owns it.
  const pidAlive = (pid: number) =>
    capture("ps", ["-p", String(pid), "-o", "pid="]).pipe(
      Effect.map(({ code }) => code === 0),
      Effect.orElseSucceed(() => false),
    );

  const statOf = (target: string) => fs.stat(target).pipe(Effect.option);

  const isDirectory = (target: string) =>
    fs.stat(target).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );

  const isMissing = (target: string) =>
    fs.stat(target).pipe(
      Effect.as(false),
      Effect.catchIf(isNotFound, () => Effect.succeed(true)),
      Effect.orElseSucceed(() => false),
    );

  const realPath = (target: string) => fs.realPath(target).pipe(Effect.option);

  // Whether two paths name the same directory once symlinks are gone.
  // False when either can't be resolved: "can't tell" isn't "same".
  const sameDirectory = (a: string, b: string) =>
    Effect.map(
      Effect.all([realPath(a), realPath(b)]),
      ([ra, rb]) =>
        Option.isSome(ra) && Option.isSome(rb) && ra.value === rb.value,
    );

  const readText = (target: string) =>
    fs.readFileString(target).pipe(Effect.option);

  // --- environment ---

  const checkGit = Effect.gen(function* () {
    const version = yield* git.run(home, ["--version"]).pipe(Effect.option);
    if (Option.isNone(version)) {
      return [
        fail(
          "Environment",
          "git",
          "git",
          "not runnable (every command in sm shells out to it)",
          "Install git (`xcode-select --install`) and make sure it's on PATH.",
        ),
      ];
    }
    const trimmed = version.value.trim();
    const raw = (
      trimmed.startsWith("git version ")
        ? trimmed.slice("git version ".length)
        : trimmed
    ).trim();
    const parsed = parseGitVersion(raw);
    if (parsed !== undefined && belowGitFloor(parsed.major, parsed.minor)) {
      return [
        warn(
          "Environment",
          "git",
          "git",
          `${raw} is older than 2.40, which sm's worktree creation needs`,
          "Upgrade git (`brew upgrade git`).",
        ),
      ];
    }
    return [ok("Environment", "git", "git", raw)];
  });

  const checkGh = Effect.gen(function* () {
    if (Option.isNone(yield* findExecutable("gh"))) {
      return [
        warn(
          "Environment",
          "gh",
          "gh",
          "not on PATH, so pr, merge, and land can't talk to GitHub without it",
          "Install the GitHub CLI (`brew install gh`), then `gh auth login`.",
        ),
      ];
    }
    // Only success matters: `gh auth status` prints account details that
    // have no business in sm's output.
    const auth = yield* capture("gh", ["auth", "status"]).pipe(Effect.option);
    if (Option.isNone(auth) || auth.value.code !== 0) {
      return [
        warn(
          "Environment",
          "gh",
          "gh",
          "installed but not authenticated",
          "Run `gh auth login`.",
        ),
      ];
    }
    const version = yield* capture("gh", ["--version"]).pipe(Effect.option);
    let shown = "installed";
    if (Option.isSome(version) && version.value.code === 0) {
      const first = version.value.stdout.split("\n")[0] ?? "";
      const words = fields(first);
      shown =
        words.length >= 3 && words[0] === "gh" && words[1] === "version"
          ? (words[2] ?? "")
          : first.trim();
    }
    return [ok("Environment", "gh", "gh", `${shown}, authenticated`)];
  });

  const appRoots = [
    "/Applications",
    path.join(home, "Applications"),
    "/System/Applications",
  ];

  // The prod binary runs from <bundle>/Contents/Resources (the PATH
  // command is a symlink there), so its bundle is two folders up.
  const installedBundle = (executable: string) =>
    Effect.gen(function* () {
      const exe = Option.getOrElse(
        yield* realPath(executable),
        () => executable,
      );
      const resources = path.dirname(exe);
      const contents = path.dirname(resources);
      const bundle = path.dirname(contents);
      return path.basename(resources) === "Resources" &&
        path.basename(contents) === "Contents" &&
        bundle.endsWith(".app")
        ? Option.some(bundle)
        : Option.none<string>();
    });

  // The app in one of the conventional install locations.
  const findInstalledBundle = Effect.gen(function* () {
    for (const root of appRoots) {
      const candidate = path.join(root, `${APP_NAME}.app`);
      if (Option.isSome(yield* statOf(candidate)))
        return Option.some(candidate);
    }
    return Option.none<string>();
  });

  // The swap sets the installed app aside before renaming the new one
  // in. A crash between the two leaves the aside copy as the only app.
  const findAsideBundle = Effect.gen(function* () {
    for (const root of appRoots) {
      const entries = yield* fs
        .readDirectory(root)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      const [aside] = entries
        .filter((name) => name.startsWith(`${APP_NAME}.app.old-`))
        .toSorted();
      if (aside !== undefined) return Option.some(path.join(root, aside));
    }
    return Option.none<string>();
  });

  // CFBundleShortVersionString, empty when it can't be read.
  const bundleVersion = (bundle: string) =>
    capture("defaults", [
      "read",
      path.join(bundle, "Contents", "Info"),
      "CFBundleShortVersionString",
    ]).pipe(
      Effect.map(({ stdout, code }) => (code === 0 ? stdout.trim() : "")),
      Effect.orElseSucceed(() => ""),
    );

  // The binary's own identity, and whether the app bundle behind it
  // agrees: a version mismatch means the sm on PATH is a stray copy
  // that `sm update` won't carry along.
  const checkApp = (version: string, executable: string) =>
    Effect.gen(function* () {
      if (flavor !== "prod") {
        return [
          ok(
            "Environment",
            "app",
            "app",
            `dev build (${binaryName} ${version}): runs from a checkout, no installed bundle`,
          ),
        ];
      }
      const bundle = yield* installedBundle(executable);
      if (Option.isNone(bundle)) {
        const found = yield* findInstalledBundle;
        if (Option.isSome(found)) {
          return [
            warn(
              "Environment",
              "app",
              "app",
              `this binary isn't the one inside ${collapseHome(found.value)}, so \`${binaryName} update\` can't reach it`,
              `Re-link the CLI from the app's Settings, or run ${collapseHome(path.join(found.value, "Contents", "Resources", binaryName))}.`,
            ),
          ];
        }
        const aside = yield* findAsideBundle;
        if (Option.isSome(aside)) {
          return [
            fail(
              "Environment",
              "app",
              "app",
              `the app is missing, but ${collapseHome(aside.value)} is the copy an interrupted update set aside`,
              `Rename it back to ${APP_NAME}.app.`,
            ),
          ];
        }
        return [
          warn(
            "Environment",
            "app",
            "app",
            "no installed app bundle found, so update, app, and the port-pool toggle have nothing behind them",
            "Install Shigoto no Mori, or use the dev CLI (smd) against a checkout.",
          ),
        ];
      }
      const appVersion = yield* bundleVersion(bundle.value);
      if (appVersion === "") {
        return [
          warn(
            "Environment",
            "app",
            "app",
            `${collapseHome(bundle.value)} has no readable version in Info.plist`,
            "Reinstall the app.",
          ),
        ];
      }
      if (appVersion !== version) {
        return [
          warn(
            "Environment",
            "app",
            "app",
            `app is ${appVersion} but this CLI is ${version}. They ship together, so one of them is stale`,
            `Run \`${binaryName} update\`, or re-link the CLI from the app's Settings.`,
          ),
        ];
      }
      return [
        ok(
          "Environment",
          "app",
          "app",
          `${appVersion} at ${collapseHome(bundle.value)}`,
        ),
      ];
    });

  // The binary in PATH order, deduped by the file each entry resolves
  // to, so a symlink and its target don't read as a conflict.
  const binariesOnPath = Effect.gen(function* () {
    const searched = yield* env("PATH");
    const found: string[] = [];
    const seen = new Set<string>();
    for (const dir of searched === "" ? [] : searched.split(":")) {
      const candidate = path.join(dir === "" ? "." : dir, binaryName);
      const info = yield* statOf(candidate);
      if (
        Option.isNone(info) ||
        info.value.type === "Directory" ||
        (info.value.mode & 0o111) === 0
      ) {
        continue;
      }
      const resolved = Option.getOrElse(
        yield* realPath(candidate),
        () => candidate,
      );
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      found.push(collapseHome(candidate));
    }
    return found;
  });

  // Two binaries on PATH is the quietest way for an install to go wrong:
  // the one that answers and the one the app updates are different
  // files, so fixes never seem to land.
  const checkPath = Effect.gen(function* () {
    const found = yield* binariesOnPath;
    const [first] = found;
    if (first === undefined) {
      return [
        warn(
          "Environment",
          "path",
          "PATH",
          `no \`${binaryName}\` on PATH, so this run came from an explicit path`,
          "Link the CLI from the app's Settings, or add its directory to PATH.",
        ),
      ];
    }
    if (found.length === 1) return [ok("Environment", "path", "PATH", first)];
    return [
      warn(
        "Environment",
        "path",
        "PATH",
        `${found.length} different \`${binaryName}\` binaries on PATH; ${first} wins`,
        `Remove the shadowed copies (${found.slice(1).join(", ")}) or reorder PATH.`,
      ),
    ];
  });

  const isFile = (target: string) =>
    Effect.map(
      statOf(target),
      (info) => Option.isSome(info) && info.value.type === "File",
    );

  // The rc file each shell reads, where install writes the hook.
  const hookPath = (kind: ShellKind) =>
    Effect.gen(function* () {
      if (kind === "zsh") {
        return path.join(zdotdir === "" ? home : zdotdir, ".zshrc");
      }
      if (kind === "bash") {
        // macOS terminals start bash as a login shell, which never reads
        // .bashrc.
        for (const name of [".bash_profile", ".bash_login", ".profile"]) {
          const candidate = path.join(home, name);
          if (yield* isFile(candidate)) return candidate;
        }
        return path.join(home, ".bash_profile");
      }
      return path.join(configHome, "fish", "conf.d", `${names.alias}.fish`);
    });

  // Whether the shell's hook is installed and recognizably ours, and
  // whether it is what this build would write.
  const inspectHook = (kind: ShellKind) =>
    Effect.gen(function* () {
      const file = yield* hookPath(kind);
      const text = yield* fs.readFileString(file).pipe(
        Effect.asSome,
        Effect.catchIf(isNotFound, () => Effect.succeed(Option.none<string>())),
        // Unreadable isn't absent: hands off.
        Effect.orElseSucceed(() => undefined),
      );
      if (text === undefined)
        return { state: "modified" as const, current: true };
      if (Option.isNone(text))
        return { state: "missing" as const, current: true };
      if (kind === "fish") {
        return text.value.includes(hookBeginMarker(hookNames))
          ? {
              state: "installed" as const,
              current: text.value === fishHookContent(hookNames),
            }
          : { state: "modified" as const, current: true };
      }
      const lines = text.value.split("\n");
      const span = findHookSpan(hookNames, lines);
      if (span.kind === "none")
        return { state: "missing" as const, current: true };
      if (span.kind === "broken" || !span.ours) {
        return { state: "modified" as const, current: true };
      }
      return {
        state: "installed" as const,
        current:
          lines.slice(span.begin, span.end + 1).join("\n") ===
          hookBlock(hookNames, kind).replace(/\n+$/, ""),
      };
    });

  // Installed and current: install refreshes the block in place, so one
  // from an older vintage was written by a build whose guard line has
  // since changed.
  const checkShellHook = (terminal: boolean) =>
    Effect.gen(function* () {
      const installed: ShellKind[] = [];
      const edited: ShellKind[] = [];
      const stale: ShellKind[] = [];
      for (const kind of SHELL_KINDS) {
        const hook = yield* inspectHook(kind);
        if (hook.state === "installed") {
          installed.push(kind);
          if (!hook.current) stale.push(kind);
        } else if (hook.state === "modified") {
          edited.push(kind);
        }
      }
      if (edited.length > 0) {
        return [
          warn(
            "Environment",
            "shell-hook",
            "shell hook",
            `the block in ${edited.join(", ")}'s config was edited, so install and uninstall won't touch it`,
            `Restore or remove the marker block, then \`${binaryName} shell install\`.`,
          ),
        ];
      }
      if (stale.length > 0) {
        return [
          warn(
            "Environment",
            "shell-hook",
            "shell hook",
            `the ${stale.join(", ")} hook is an older vintage than this build writes`,
            `Run \`${binaryName} shell install\` to refresh it.`,
          ),
        ];
      }
      if (installed.length === 0) {
        return [
          warn(
            "Environment",
            "shell-hook",
            "shell hook",
            "not installed, so cd and create open a subshell instead of moving your shell",
            `Run \`${binaryName} shell install\`.`,
          ),
        ];
      }
      // "This session" is a terminal's. Without one (the app's read) it
      // would always read as a problem.
      const inactive = terminal && cdFile === "";
      return [
        ok(
          "Environment",
          "shell-hook",
          "shell hook",
          `installed for ${installed.join(", ")}${inactive ? " (not active in this session)" : ""}`,
        ),
      ];
    });

  // --- the data dir ---

  const sourceText = (() => {
    switch (paths.dataDirSource) {
      case "env":
        return "from SHIGOMORI_DATA_DIR";
      case "pointer":
        return "from the pointer file";
      case "legacy":
        return "pre-2.0 name";
      case "default":
        return `default for the ${flavor} flavor`;
    }
  })();

  // Whether a directory has been used as a data dir.
  const holdsState = (dir: string) =>
    Effect.gen(function* () {
      let unreadable = false;
      for (const file of STATE_FILES) {
        const exists = yield* fs.stat(path.join(dir, file)).pipe(
          Effect.as(true),
          Effect.catchIf(isAbsent, () => Effect.succeed(false)),
          Effect.orElseSucceed(() => {
            unreadable = true;
            return false;
          }),
        );
        if (exists) return "present" as const;
      }
      return unreadable ? ("unreadable" as const) : ("absent" as const);
    });

  // A directory a pointer may aim at: one that doesn't exist yet, is
  // empty, or already holds sm's state.
  const looksLikeDataDir = (target: string) =>
    fs.readDirectory(target).pipe(
      Effect.map(
        (entries) =>
          entries.length === 0 ||
          entries.some((entry) => STATE_FILES.some((file) => file === entry)),
      ),
      Effect.catchIf(isNotFound, () => Effect.succeed(true)),
      Effect.orElseSucceed(() => false),
    );

  // The pointer file as Paths read it: the file, the target it names,
  // and why the target was refused (empty when it wasn't).
  const readPointer = Effect.gen(function* () {
    const dir = path.join(configHome, names.configDir);
    for (const name of [names.pointer, names.legacyPointer]) {
      const file = path.join(dir, name);
      const raw = yield* readText(file);
      if (Option.isNone(raw)) continue;
      const target = paths.expandHome(raw.value.trim());
      const problem =
        target === ""
          ? "it is empty"
          : !path.isAbsolute(target)
            ? "it isn't an absolute path"
            : !(yield* looksLikeDataDir(target))
              ? "it holds files that aren't sm's"
              : "";
      return Option.some({ file, target, problem });
    }
    return Option.none<{ file: string; target: string; problem: string }>();
  });

  // "/Volumes/<name>" when the path is on a volume that isn't mounted.
  const unmountedVolume = (target: string) =>
    Effect.gen(function* () {
      if (!target.startsWith("/Volumes/")) return "";
      const name = target.slice("/Volumes/".length).split("/")[0] ?? "";
      const volume = `/Volumes/${name}`;
      if (name === "" || Option.isSome(yield* statOf(volume))) return "";
      return volume;
    });

  // ~/<name>, a data dir sm isn't using, still holding state that is
  // now silently ignored.
  const ignoredCopy = (name: string, fix: string) =>
    Effect.gen(function* () {
      const other = path.join(home, name);
      if (
        other === dataDir ||
        (yield* sameDirectory(other, dataDir)) ||
        (yield* holdsState(other)) !== "present"
      ) {
        return Option.none<Entry>();
      }
      return Option.some(
        warn(
          "Data dir",
          "data-dir",
          "data dir",
          `${collapseHome(dataDir)} (${sourceText}); ${collapseHome(other)} also holds state and is ignored`,
          fix,
        ),
      );
    });

  // The data dir's line, and whether there is a data dir the other
  // checks can read.
  const checkDataDir = Effect.gen(function* () {
    const shown = `${collapseHome(dataDir)} (${sourceText})`;
    // A pointer that fails the guard is skipped without a word, which
    // reads as every project vanishing.
    if (paths.dataDirSource === "default") {
      const pointer = yield* readPointer;
      if (
        Option.isSome(pointer) &&
        pointer.value.target !== "" &&
        pointer.value.problem !== ""
      ) {
        return {
          entries: [
            warn(
              "Data dir",
              "data-dir",
              "data dir",
              `the pointer file names ${pointer.value.target}, which was ignored because ${pointer.value.problem}, so sm is using ${shown}`,
              `Fix ${collapseHome(pointer.value.file)} to name a data dir, or delete it.`,
            ),
          ],
          usable: yield* isDirectory(dataDir),
        };
      }
    }
    const info = yield* fs.stat(dataDir).pipe(Effect.result);
    if (Result.isFailure(info)) {
      if (isNotFound(info.failure)) {
        const addProject = `\`${binaryName} projects add\``;
        let fix = `Add a project (${addProject}) and it will be created.`;
        if (paths.dataDirSource === "pointer") {
          const pointer = yield* readPointer;
          const file = collapseHome(
            Option.match(pointer, { onNone: () => "", onSome: (p) => p.file }),
          );
          const volume = yield* unmountedVolume(dataDir);
          if (volume !== "") {
            return {
              entries: [
                fail(
                  "Data dir",
                  "data-dir",
                  "data dir",
                  `the pointer file names ${dataDir}, on ${volume}, which isn't connected`,
                  `Connect the drive. To start over on this Mac instead, delete ${file}.`,
                ),
              ],
              usable: false,
            };
          }
          fix = `If the data was moved or deleted, fix or delete ${file}. Otherwise add a project (${addProject}) and it will be created.`;
        }
        return {
          entries: [
            warn(
              "Data dir",
              "data-dir",
              "data dir",
              `${collapseHome(dataDir)} doesn't exist yet (${sourceText}), so nothing is registered`,
              fix,
            ),
          ],
          usable: false,
        };
      }
      return {
        entries: [
          fail(
            "Data dir",
            "data-dir",
            "data dir",
            `${collapseHome(dataDir)} can't be read: ${info.failure.message}`,
            `Check the permissions on ${collapseHome(dataDir)}.`,
          ),
        ],
        usable: false,
      };
    }
    if (info.success.type !== "Directory") {
      return {
        entries: [
          fail(
            "Data dir",
            "data-dir",
            "data dir",
            `${collapseHome(dataDir)} is a file, not a directory (${sourceText})`,
            "Move it aside, or point SHIGOMORI_DATA_DIR somewhere else.",
          ),
        ],
        usable: false,
      };
    }
    const writable = yield* fs.access(dataDir, { writable: true }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (!writable) {
      return {
        entries: [
          fail(
            "Data dir",
            "data-dir",
            "data dir",
            `${collapseHome(dataDir)} isn't writable, so no command that changes state can work`,
            "Fix its ownership or permissions.",
          ),
        ],
        usable: true,
      };
    }
    if (paths.dataDirSource === "legacy") {
      return {
        entries: [
          warn(
            "Data dir",
            "data-dir",
            "data dir",
            shown,
            `Rename it to ~/${names.dataDir} from the app's Settings > Data location.`,
          ),
        ],
        usable: true,
      };
    }
    // A data-folder move copies, repoints, then deletes the old copy, so
    // one that died after the repoint leaves the old tree behind. Both
    // names holding state means an upgrade seeded the current one while
    // the old one was unreachable.
    const ignored =
      paths.dataDirSource === "pointer"
        ? yield* ignoredCopy(
            names.dataDir,
            "If a data-folder move left it behind, delete it once you've checked nothing in it is newer.",
          )
        : paths.dataDirSource === "default"
          ? yield* ignoredCopy(
              names.legacyDataDir,
              "Move it aside, or merge what you need from it by hand.",
            )
          : Option.none<Entry>();
    return {
      entries: [
        Option.getOrElse(ignored, () =>
          ok("Data dir", "data-dir", "data dir", shown),
        ),
      ],
      usable: true,
    };
  });

  const configFile = path.join(dataDir, "config.json");
  const registryFile = path.join(dataDir, "registry.json");

  // The device's settings, each value checked against the key it sets.
  const checkGlobalConfig = Effect.gen(function* () {
    const doc = (yield* config.read({ kind: "device" })) ?? {};
    const keys = Object.keys(doc).length;
    if (keys === 0) {
      return [
        ok("Data dir", "config", "config.json", "absent, so defaults apply"),
      ];
    }
    if (storedProblem({ kind: "device" }, doc) !== undefined) {
      return [
        warn(
          "Data dir",
          "config",
          "config.json",
          "parses, but a field has the wrong type and is being dropped",
          `Check ${collapseHome(configFile)} against the app's Settings.`,
        ),
      ];
    }
    return [
      ok(
        "Data dir",
        "config",
        "config.json",
        `valid, ${keys} key${plural(keys)}`,
      ),
    ];
  });

  const checkRegistry = Effect.gen(function* () {
    const projects = yield* registry.projects;
    const malformed = projects.filter(
      (project) => project.id === "" || project.path === "",
    ).length;
    if (malformed > 0) {
      return [
        warn(
          "Data dir",
          "registry",
          "registry.json",
          `${malformed} registry ${pluralize(malformed, "entry is", "entries are")} missing an id or path`,
          `Remove the incomplete entries from ${collapseHome(registryFile)}.`,
        ),
      ];
    }
    return [
      ok(
        "Data dir",
        "registry",
        "registry.json",
        `valid, ${projects.length} project${plural(projects.length)} registered`,
      ),
    ];
  });

  // Lock files under the data dir older than a write can take: the
  // data dir itself, each project's folder and its worktrees folder,
  // and iconCache/. updates/ holds downloads, never a lock.
  const findStaleLocks = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const stale: string[] = [];
    const scan = (dir: string) =>
      Effect.gen(function* () {
        const entries = yield* fs
          .readDirectory(dir)
          .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
        for (const name of entries) {
          if (!name.endsWith(".lock")) continue;
          const file = path.join(dir, name);
          const info = yield* statOf(file);
          if (
            Option.isNone(info) ||
            info.value.type === "Directory" ||
            now - mtimeOf(info.value) <= LOCK_STALE_MS
          ) {
            continue;
          }
          stale.push(file);
        }
      });
    yield* scan(dataDir);
    yield* scan(path.join(dataDir, "iconCache"));
    const projectsDir = path.join(dataDir, "projects");
    const projectDirs = yield* fs
      .readDirectory(projectsDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const name of projectDirs) {
      const dir = path.join(projectsDir, name);
      if (!(yield* isDirectory(dir))) continue;
      yield* scan(dir);
      yield* scan(path.join(dir, "worktrees"));
    }
    return stale.toSorted();
  });

  const removeIfPresent = (target: string) =>
    fs.remove(target).pipe(Effect.catchIf(isNotFound, () => Effect.void));

  const checkStaleLocks = Effect.gen(function* () {
    const locks = yield* findStaleLocks;
    const [first] = locks;
    if (first === undefined) {
      return [ok("Data dir", "locks", "locks", "no stale lock files")];
    }
    const shown = locks.map(collapseHome);
    const label = `${locks.length} stale lock file${plural(locks.length)}`;
    const extra = locks.length - 1;
    return [
      repairable(
        warn(
          "Data dir",
          "locks",
          "locks",
          `${collapseHome(first)} has been held for longer than a write can take${extra > 0 ? ` (and ${extra} more)` : ""}`,
          "Delete it. The process that took it is gone.",
        ),
        {
          prompt: `Delete ${label} (${shown.join(", ")})?`,
          label: `deleted ${label}`,
          destructive: true,
          apply: Effect.forEach(locks, removeIfPresent, { discard: true }),
        },
      ),
    ];
  });

  const updatesDir = path.join(dataDir, "updates");
  const stagingLock = path.join(updatesDir, "staging.pid");
  const stagedDir = path.join(updatesDir, "staged");

  // Who holds the update stager's pidfile: none when there is none, and
  // pid 0 when its content isn't one.
  const stagingHolder = Effect.gen(function* () {
    const raw = yield* readText(stagingLock);
    if (Option.isNone(raw)) return Option.none();
    const pid = atoi(raw.value.trim());
    // kill(0) and kill(-1) always "succeed".
    if (pid === undefined || pid < 2) {
      return Option.some({ pid: 0, alive: false });
    }
    return Option.some({ pid, alive: yield* pidAlive(pid) });
  });

  // The stager holds its pidfile for a whole download, so a crashed one
  // is told by its pid being dead, not by the file's age.
  const checkStagingLock = Effect.gen(function* () {
    const holder = yield* stagingHolder;
    if (Option.isNone(holder)) return [];
    const { pid, alive } = holder.value;
    if (alive) {
      return [
        ok(
          "Data dir",
          "staging-lock",
          "update staging",
          `in progress (pid ${pid})`,
        ),
      ];
    }
    return [
      repairable(
        warn(
          "Data dir",
          "staging-lock",
          "update staging",
          `left behind by a crashed update${pid !== 0 ? ` (pid ${pid} is gone)` : ""}, so \`${binaryName} update\` refuses to run`,
          `Delete ${collapseHome(stagingLock)}.`,
        ),
        {
          prompt: `Delete the stale update staging lock at ${collapseHome(stagingLock)}?`,
          label: "deleted the stale update staging lock",
          destructive: true,
          apply: fs.remove(stagingLock),
        },
      ),
    ];
  });

  // The scratch a staging run left (the download and its extraction),
  // plus a staged bundle this build already is or is newer than. An
  // unparseable version on either side is "can't tell", never leftover.
  const updateLeftovers = (version: string) =>
    Effect.gen(function* () {
      const found: string[] = [];
      for (const scratch of [
        path.join(updatesDir, "download.zip"),
        path.join(updatesDir, "extract"),
      ]) {
        if (yield* fs.exists(scratch).pipe(Effect.orElseSucceed(() => false))) {
          found.push(scratch);
        }
      }
      const manifest = yield* readText(path.join(stagedDir, "manifest.json"));
      const staged = Option.flatMap(manifest, (text) =>
        Schema.decodeOption(StagedManifest)(text),
      );
      if (Option.isSome(staged)) {
        const stagedVersion = staged.value.version ?? "";
        if (
          parseSemver(stagedVersion) !== undefined &&
          parseSemver(version) !== undefined &&
          !newerThan(stagedVersion, version)
        ) {
          found.push(stagedDir);
        }
      }
      return found;
    });

  // The bytes of the files under a path, the path itself when a file.
  const treeSize = (root: string) =>
    Effect.gen(function* () {
      const info = yield* statOf(root);
      if (Option.isNone(info)) return 0;
      if (info.value.type !== "Directory") return Number(info.value.size);
      const entries = yield* fs
        .readDirectory(root, { recursive: true })
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      let size = 0;
      for (const entry of entries) {
        const item = yield* statOf(path.join(root, entry));
        if (Option.isSome(item) && item.value.type !== "Directory") {
          size += Number(item.value.size);
        }
      }
      return size;
    });

  // A crashed or superseded update leaves its scratch until the next
  // update sweeps it. Only while no stager holds the lock: mid-run,
  // these are its working files.
  const checkUpdateLeftovers = (version: string) =>
    Effect.gen(function* () {
      const holder = yield* stagingHolder;
      if (Option.isSome(holder) && holder.value.alive) return [];
      const found = yield* updateLeftovers(version);
      if (found.length === 0) return [];
      let size = 0;
      for (const item of found) size += yield* treeSize(item);
      const shown = formatSize(size);
      return [
        repairable(
          warn(
            "Data dir",
            "update-leftovers",
            "update files",
            `${shown} of downloads left by an earlier update that nothing will install`,
            "Delete them, or let the next update sweep them.",
          ),
          {
            prompt: `Delete ${shown} of leftover update files in ${collapseHome(updatesDir)}?`,
            label: `deleted ${shown} of leftover update files`,
            destructive: true,
            // Listed again when it runs: a stager that started since, or
            // staged something newer, keeps its files.
            apply: Effect.gen(function* () {
              const now = yield* stagingHolder;
              if (Option.isSome(now) && now.value.alive) {
                return yield* new UpdateInProgress({ pid: now.value.pid });
              }
              for (const item of yield* updateLeftovers(version)) {
                yield* fs.remove(item, { recursive: true });
              }
            }),
          },
        ),
      ];
    });

  const deviceDoc = Effect.map(
    config.read({ kind: "device" }),
    (doc) => doc ?? {},
  );

  // port-pool leases are keyed by directory and live in port-pool's own
  // state. One whose directory is gone stays reserved forever. Reported,
  // never fixed: the state belongs to port-pool.
  const checkPortAllocations = Effect.gen(function* () {
    if ((yield* deviceDoc)["portPool"] !== true) return [];
    if (Option.isNone(yield* findExecutable("port-pool"))) {
      return [
        warn(
          "Data dir",
          "ports",
          "port pool",
          "enabled in config.json but `port-pool` isn't on PATH, so provisioning is skipped",
          "Install port-pool, or turn the toggle off in the app's Settings.",
        ),
      ];
    }
    const listed = yield* capture("port-pool", ["list"]).pipe(Effect.result);
    const failure = Result.isFailure(listed)
      ? listed.failure.message
      : listed.success.code !== 0
        ? `exit status ${listed.success.code}`
        : undefined;
    if (failure !== undefined || Result.isFailure(listed)) {
      return [
        warn(
          "Data dir",
          "ports",
          "port pool",
          `\`port-pool list\` failed: ${failure ?? ""}`,
          "Run `port-pool list` by hand to see what it says.",
        ),
      ];
    }
    const dirs = parsePortPoolDirs(listed.success.stdout);
    let orphans = 0;
    for (const dir of dirs) {
      if (yield* isMissing(dir)) orphans++;
    }
    if (orphans === 0) {
      return [
        ok(
          "Data dir",
          "ports",
          "port pool",
          `${dirs.length} allocation${plural(dirs.length)}, all pointing at directories that exist`,
        ),
      ];
    }
    return [
      warn(
        "Data dir",
        "ports",
        "port pool",
        `${orphans} of ${dirs.length} allocations point at directories that are gone, so those ports stay reserved`,
        `Run \`port-pool prune\` (it owns that state, so ${binaryName} won't touch it).`,
      ),
    ];
  });

  // Custom launchers fire and forget through /bin/sh, so one whose
  // program isn't installed fails with nothing on screen.
  const missingLaunchers = (
    commands: ReadonlyArray<{
      readonly label: string;
      readonly command: string;
    }>,
  ) =>
    Effect.gen(function* () {
      const missing: Array<{ label: string; program: string }> = [];
      for (const { label, command } of commands) {
        const program = launcherProgram(command, paths.expandHome);
        if (program === "") continue;
        const present = program.startsWith("/")
          ? Option.isSome(yield* statOf(program))
          : Option.isSome(yield* findExecutable(program));
        if (!present) missing.push({ label, program });
      }
      return missing;
    });

  const launcherFindings = (
    group: Group,
    id: string,
    title: string,
    commands: ReadonlyArray<{
      readonly label: string;
      readonly command: string;
    }>,
    rm: string,
    scope: string,
  ) =>
    Effect.map(missingLaunchers(commands), (missing) =>
      missing.map(({ label, program }) =>
        warn(
          group,
          id,
          title,
          `the ${label} launcher runs ${program}, which isn't installed or on PATH`,
          `Install it, or fix the launcher (\`${binaryName} ${rm} ${shellWord(label)}${scope}\`, then add it again).`,
        ),
      ),
    );

  // The global launchers, the ones every project's row carries.
  const checkGlobalLaunchers = Effect.flatMap(deviceDoc, (doc) =>
    launcherFindings(
      "Data dir",
      "launchers",
      "launchers",
      launcherCommands(doc),
      "config launcher rm",
      "",
    ),
  );

  // Terrier's registry is terrier's, and sm only merges it in, so this
  // says why merged projects might be missing.
  const checkTerrier = Effect.gen(function* () {
    if ((yield* deviceDoc)["terrier"] !== true) return [];
    const listing = yield* terrier.listing;
    if (Option.isSome(listing.trouble)) {
      return [
        warn(
          "Data dir",
          "terrier",
          "terrier",
          listing.trouble.value.summary,
          listing.trouble.value.advice,
        ),
      ];
    }
    const count = listing.paths.length;
    return [
      ok(
        "Data dir",
        "terrier",
        "terrier",
        `${count} registered repo${plural(count)} merged into the project list`,
      ),
    ];
  });

  // A project's state that no listed project claims is dormant: terrier
  // rm of a repo sm held settings for leaves it, since the id is all
  // that ties it to a path. Reported, never fixed: re-registering the
  // path under terrier brings back the same id and picks it up again.
  const checkDormantState = (
    projects: ReadonlyArray<ListedProject>,
    complete: boolean,
  ) =>
    Effect.gen(function* () {
      if (!complete) return [];
      const rows = yield* sql<{ project_id: string }>`
        SELECT project_id FROM project_config
        UNION SELECT project_id FROM worktree_data`.pipe(Effect.orDie);
      const total = rows.length;
      if (total === 0) return [];
      const claimed = new Set(projects.map(({ id }) => id));
      const dormant = rows
        .map(({ project_id }) => project_id)
        .filter((id) => !claimed.has(id))
        .toSorted();
      const [first] = dormant;
      if (first === undefined) {
        return [
          ok(
            "Data dir",
            "dormant-state",
            "project state",
            `${total} state dir${plural(total)}, each belonging to a project`,
          ),
        ];
      }
      const extra = dormant.length - 1;
      return [
        warn(
          "Data dir",
          "dormant-state",
          "project state",
          `${dormant.length} state ${pluralize(dormant.length, "dir belongs", "dirs belong")} to no project (${first}${extra > 0 ? ` and ${extra} more` : ""})`,
          `Harmless: it reconnects if terrier lists the repo again (re-added, or the terrier toggle back on). Otherwise delete it from ${collapseHome(path.join(dataDir, "projects"))} by hand.`,
        ),
      ];
    });

  // Everything kept by worktree id: the marks, the shelf snapshots and
  // each worktree's data. Removing a worktree clears them, so ids that
  // match nothing mean worktrees were removed outside sm. Harmless, so
  // reported and never cleared. With the project list short, every mark
  // of a missing project would read as a leftover, so it stands down.
  const checkBookkeeping = (
    projects: ReadonlyArray<ListedProject>,
    complete: boolean,
  ) =>
    Effect.gen(function* () {
      if (!complete) return [];
      const known = new Set<string>();
      const idsOf = new Map<string, ReadonlySet<string>>();
      for (const project of projects) {
        // An unreadable repo would make every id look orphaned.
        const found = yield* worktrees.identities(project).pipe(Effect.option);
        if (Option.isNone(found)) return [];
        const ids = new Set(found.value.map(({ id }) => id));
        for (const id of ids) known.add(id);
        idsOf.set(project.id, ids);
      }
      const dataRows = yield* sql<{ project_id: string; worktree_id: string }>`
        SELECT project_id, worktree_id FROM worktree_data`.pipe(Effect.orDie);
      const dataFiles = dataRows.filter(({ project_id, worktree_id }) => {
        const ids = idsOf.get(project_id);
        return ids !== undefined && !ids.has(worktree_id);
      }).length;
      const snapshots = yield* sql<{ worktree_id: string }>`
        SELECT worktree_id FROM shelf_snapshots`.pipe(Effect.orDie);
      const sets: ReadonlyArray<ReadonlySet<string>> = [
        yield* registry.marked("shelved"),
        yield* registry.marked("autoPull"),
        yield* registry.marked("agentWorking"),
        new Set(snapshots.map(({ worktree_id }) => worktree_id)),
      ];
      const marked = new Set<string>();
      let leftover = 0;
      for (const set of sets) {
        for (const id of set) {
          marked.add(id);
          if (!known.has(id)) leftover++;
        }
      }
      if (leftover === 0 && dataFiles === 0) {
        return marked.size > 0
          ? [
              ok(
                "Data dir",
                "bookkeeping",
                "worktree marks",
                `${marked.size} worktree${plural(marked.size)} marked, all still present`,
              ),
            ]
          : [];
      }
      const parts = [
        ...(leftover > 0 ? [`${leftover} mark${plural(leftover)}`] : []),
        ...(dataFiles > 0
          ? [`${dataFiles} data file${plural(dataFiles)}`]
          : []),
      ];
      return [
        warn(
          "Data dir",
          "bookkeeping",
          "worktree marks",
          `${parts.join(" and ")} belong to worktrees that no longer exist`,
          `Harmless, and some may belong to a project that isn't listed right now. Removing worktrees with \`${binaryName} rm\` or from the app leaves none behind.`,
        ),
      ];
    });

  // --- what a crash left running ---

  // The app records its cloudflared child's pid and kills a leftover one
  // at its next launch. Until then a tunnel whose app crashed keeps this
  // Mac reachable.
  const checkOrphanTunnel = Effect.gen(function* () {
    const userData = path.join(
      home,
      "Library",
      "Application Support",
      flavor === "prod" ? APP_NAME : `${APP_NAME} (dev)`,
    );
    const raw = yield* readText(path.join(userData, "cloudflared.pid"));
    if (Option.isNone(raw)) return [];
    const pid = atoi(raw.value.trim());
    if (pid === undefined || pid < 2) return [];
    const ps = yield* capture("ps", [
      "-o",
      "ppid=,comm=",
      "-p",
      String(pid),
    ]).pipe(Effect.option);
    // Gone, which is the ordinary case.
    if (Option.isNone(ps) || ps.value.code !== 0) return [];
    const line = ps.value.stdout.trim();
    const space = line.indexOf(" ");
    const ppid = space < 0 ? line : line.slice(0, space);
    const comm = space < 0 ? "" : line.slice(space + 1);
    // Reparented to launchd is what outliving the app looks like. With
    // the app alive it is the app's child, and the app's business.
    if (!comm.toLowerCase().includes("cloudflared") || ppid.trim() !== "1") {
      return [];
    }
    return [
      warn(
        "Processes",
        "tunnel",
        "tunnel",
        `a cloudflared tunnel (pid ${pid}) outlived the app that started it, so this Mac stays reachable through it`,
        `Open the app, which stops it at launch, or run \`kill ${pid}\`.`,
      ),
    ];
  });

  // The dev servers and scripts the app started outlive a crashed app
  // until its next launch stops them, holding their ports.
  const checkOrphanScripts = Effect.gen(function* () {
    const raw = yield* readText(path.join(dataDir, "running-scripts.json"));
    const file = Option.flatMap(raw, (text) =>
      Schema.decodeOption(RunningScripts)(text),
    );
    if (Option.isNone(file)) return [];
    const ownerPid = file.value.ownerPid ?? 0;
    const scripts = file.value.scripts ?? [];
    if (scripts.length === 0 || ownerPid < 2 || (yield* pidAlive(ownerPid))) {
      return [];
    }
    const pids = scripts
      .map(({ pid }) => pid ?? 0)
      .filter((pid) => pid >= 2)
      .map(String);
    if (pids.length === 0) return [];
    // Non-zero when none are alive.
    const ps = yield* capture(
      "ps",
      ["-p", pids.join(","), "-o", "pid=,lstart="],
      {
        env: { LC_ALL: "C" },
      },
    ).pipe(Effect.option);
    const live = parseProcessTable(
      Option.match(ps, { onNone: () => "", onSome: ({ stdout }) => stdout }),
    );
    const orphans = scripts.filter(({ pid, startedAt }) => {
      const started = live.get(pid ?? 0);
      // A recycled pid started at another time.
      return (
        started !== undefined &&
        Math.abs(started - (startedAt ?? 0)) <= SCRIPT_START_TOLERANCE_MS
      );
    });
    if (orphans.length === 0) return [];
    const n = orphans.length;
    return [
      warn(
        "Processes",
        "scripts",
        "scripts",
        `${n} script${plural(n)} the app started ${pluralize(n, "is", "are")} still running after it quit (${orphans.map(({ command }) => command ?? "").join(", ")}), holding ${pluralize(n, "its", "their")} ports`,
        `Open the app, which stops them at launch, or run \`kill ${orphans.map(({ pid }) => String(pid ?? 0)).join(" ")}\`.`,
      ),
    ];
  });

  // --- projects ---

  // The worktree's root and its repository's primary checkout.
  const locateRepo = (dir: string) =>
    git
      .run(dir, [
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--git-common-dir",
      ])
      .pipe(
        Effect.map((stdout) => {
          const [toplevel, commonDir] = stdout.trim().split("\n");
          if (toplevel === undefined || commonDir === undefined) {
            return Option.none<string>();
          }
          const common = commonDir.trim();
          return Option.some(
            path.basename(common) === ".git" ? path.dirname(common) : common,
          );
        }),
        Effect.orElseSucceed(() => Option.none<string>()),
      );

  const unregisterHint = (project: ListedProject) =>
    project.source === "terrier"
      ? `\`terrier rm ${project.name}\``
      : `\`${binaryName} projects remove ${project.name}\``;

  // Whether the project's path is a working repo, which every other
  // check needs, with what is wrong when it isn't.
  const checkProjectRepo = (project: ListedProject) =>
    Effect.gen(function* () {
      const info = yield* fs.stat(project.path).pipe(Effect.result);
      if (Result.isFailure(info) && isNotFound(info.failure)) {
        if (project.source !== undefined) {
          // Not sm's entry to drop: terrier prune owns it.
          return [
            warn(
              "Projects",
              "project-path",
              project.name,
              `${collapseHome(project.path)} is gone, but ${project.source} still lists it`,
              "Restore the directory, or run `terrier prune`.",
            ),
          ];
        }
        return [
          repairable(
            fail(
              "Projects",
              "project-path",
              project.name,
              `${collapseHome(project.path)} is gone, so every command for this project fails`,
              `If it moved, point the project at it (\`${binaryName} projects relocate ${project.name} <new-path>\`). Otherwise restore the directory, or unregister it (\`${binaryName} projects remove ${project.name}\`).`,
            ),
            {
              prompt: `Unregister ${project.name} (${collapseHome(project.path)} is gone)? Its config under projects/ goes too.`,
              label: `unregistered ${project.name}`,
              destructive: true,
              // The app may have dropped it already.
              apply: registry
                .unregister(project.id)
                .pipe(
                  Effect.asVoid,
                  Effect.catchTags({ UnknownProject: () => Effect.void }),
                ),
            },
          ),
        ];
      }
      if (Result.isFailure(info) || info.success.type !== "Directory") {
        return [
          fail(
            "Projects",
            "project-path",
            project.name,
            `${collapseHome(project.path)} isn't a readable directory`,
            `Check its permissions, or unregister it (${unregisterHint(project)}).`,
          ),
        ];
      }
      const primaryPath = yield* locateRepo(project.path);
      if (Option.isNone(primaryPath)) {
        // A bare repo has no work tree to find, and no primary to compare
        // against. Its linked worktrees are checked like any others.
        const bare = yield* git
          .run(project.path, ["rev-parse", "--is-bare-repository"])
          .pipe(
            Effect.map((stdout) => stdout.trim() === "true"),
            Effect.orElseSucceed(() => false),
          );
        if (bare) return undefined;
        return [
          fail(
            "Projects",
            "project-repo",
            project.name,
            `${collapseHome(project.path)} is no longer a git repository`,
            `Restore the repo, or unregister it (${unregisterHint(project)}).`,
          ),
        ];
      }
      if (primaryPath.value === project.path) return undefined;
      // git answers with a symlink-free path, and everything in sm
      // matches against it, so both ways this can differ are breakage.
      const detail = (yield* sameDirectory(project.path, primaryPath.value))
        ? `registered through a symlinked path; git calls the same directory ${collapseHome(primaryPath.value)}, so nothing run from inside the repo matches it`
        : `registered at ${collapseHome(project.path)}, which is a worktree of ${collapseHome(primaryPath.value)}, not the repo's primary checkout`;
      const readd =
        project.source === "terrier"
          ? `\`terrier add ${collapseHome(primaryPath.value)}\``
          : `\`${binaryName} projects add ${collapseHome(primaryPath.value)}\``;
      return [
        fail(
          "Projects",
          "project-primary",
          project.name,
          detail,
          `Unregister it (${unregisterHint(project)}) and re-add the resolved path (${readd}).`,
        ),
      ];
    });

  // Where git last saw the linked checkout now at `dir`: its .git names
  // an admin dir, whose gitdir file records "<checkout>/.git".
  const recordedWorktreePath = (dir: string) =>
    Effect.gen(function* () {
      const pointer = yield* readText(path.join(dir, ".git"));
      if (Option.isNone(pointer)) return "";
      const trimmed = pointer.value.trim();
      if (!trimmed.startsWith("gitdir: ")) return "";
      const named = trimmed.slice("gitdir: ".length);
      const admin = path.isAbsolute(named) ? named : path.join(dir, named);
      const raw = yield* readText(path.join(admin, "gitdir"));
      if (Option.isNone(raw)) return "";
      const recorded = raw.value.trim();
      if (recorded === "") return "";
      // worktree.useRelativePaths
      return path.dirname(
        path.isAbsolute(recorded) ? recorded : path.join(admin, recorded),
      );
    });

  // How git's worktree metadata and the disk disagree: checkouts git
  // lists whose folder is gone (a locked one is kept on purpose), ones
  // moved by hand (old path to new), and folders in the managed layout
  // git has no record of.
  const findDrift = (project: RegisteredProject) =>
    Effect.gen(function* () {
      const identities = yield* worktrees.identities(project);
      const known = new Set(identities.map((id) => id.path));
      const missing: WorktreeIdentity[] = [];
      for (const id of identities) {
        if (!id.locked && (yield* isMissing(id.path))) missing.push(id);
      }
      const gone = new Set(missing.map((id) => id.path));
      const moved = new Map<string, string>();
      const strays: string[] = [];
      for (const stray of yield* strayDirs(project, known)) {
        const old = yield* recordedWorktreePath(stray);
        if (gone.has(old) && !moved.has(old)) {
          moved.set(old, stray);
          continue;
        }
        strays.push(stray);
      }
      return {
        missing: missing.filter((id) => !moved.has(id.path)),
        moved,
        strays,
      };
    });

  // Folders in the managed layout git has no record of, sorted.
  const strayDirs = (project: RegisteredProject, known: ReadonlySet<string>) =>
    Effect.gen(function* () {
      const strays: string[] = [];
      for (const base of yield* layout.managedBases(project)) {
        const entries = yield* fs.readDirectory(base).pipe(Effect.option);
        if (Option.isNone(entries)) continue;
        for (const name of entries.value) {
          const dir = path.join(base, name);
          if (known.has(dir) || !(yield* isDirectory(dir))) continue;
          // A sibling project with the same folder name shares a managed
          // base, so only a stray whose metadata points back here counts.
          const primary = yield* locateRepo(dir);
          if (Option.isSome(primary) && primary.value !== project.path)
            continue;
          strays.push(dir);
        }
      }
      return strays.toSorted();
    });

  // `git worktree repair` on the new paths, then what is kept by id
  // carried from each old path's id to the new one. git repairs each
  // path on its own and fails if any failed, so the ones it did re-link
  // are re-keyed whatever it answers.
  const relink = (
    project: RegisteredProject,
    moved: ReadonlyMap<string, string>,
  ) =>
    Effect.gen(function* () {
      const repaired = yield* git
        .run(project.path, ["worktree", "repair", "--", ...moved.values()])
        .pipe(Effect.result);
      const now = yield* worktrees.identities(project).pipe(Effect.option);
      for (const [oldPath, newPath] of moved) {
        const resolved = yield* realPath(newPath);
        const found = Option.getOrElse(now, () => []).find(
          (id) =>
            id.path === newPath ||
            (Option.isSome(resolved) && id.path === resolved.value),
        );
        if (found === undefined) continue;
        yield* worktrees.rekey(
          project,
          worktreeIdFromPath(oldPath),
          found.path,
        );
      }
      if (Result.isFailure(repaired)) return yield* repaired.failure;
    });

  // `git worktree prune`, checked again when it runs: a moved worktree
  // still waiting to be re-linked would be severed by it. What sm keeps
  // per worktree goes with each pruned one, as with `sm rm`, all but a
  // pending dirty capture, which may hold the only copy of some work.
  const prune = (project: ListedProject) =>
    Effect.gen(function* () {
      const drift = yield* findDrift(project);
      if (drift.moved.size > 0) {
        return yield* new MovedWorktreePending({ project: project.name });
      }
      yield* git.pruneWorktrees(project.path);
      for (const { id } of drift.missing) {
        yield* registry.forgetWorktree(id);
        yield* data.forget(project.id, id);
        yield* cloneCheckout.forget(id);
      }
    });

  const checkProjectWorktrees = (project: ListedProject) =>
    Effect.gen(function* () {
      const found = yield* findDrift(project).pipe(Effect.result);
      if (Result.isFailure(found)) {
        const error = found.failure;
        return [
          fail(
            "Projects",
            "project-worktrees",
            project.name,
            `git can't list this project's worktrees: ${error instanceof Git.GitCommandError ? `git ${error.subcommand}: ${Git.stderrOf(error).trim()}` : error.message}`,
            `Run \`git worktree list\` in ${collapseHome(project.path)} to see the failure.`,
          ),
        ];
      }
      const drift = found.success;
      const entries: Entry[] = [];
      if (drift.moved.size > 0) {
        const n = drift.moved.size;
        const shown = [...drift.moved]
          .map(
            ([oldPath, newPath]) =>
              `${path.basename(oldPath)} → ${collapseHome(newPath)}`,
          )
          .toSorted();
        entries.push(
          repairable(
            warn(
              "Projects",
              "project-moved",
              project.name,
              `${n} worktree${plural(n)} moved without telling git (${shown.join(", ")}), so git lists the old path as missing`,
              "Re-link it (`git worktree repair <new path>`). Never prune it.",
            ),
            {
              prompt: "",
              label: `re-linked ${n} moved worktree${plural(n)} for ${project.name}`,
              destructive: false,
              apply: relink(project, drift.moved),
            },
          ),
        );
      }
      if (drift.missing.length > 0) {
        const shown = drift.missing.map(({ name }) => name);
        entries.push(
          repairable(
            warn(
              "Projects",
              "project-worktrees",
              project.name,
              `git still lists ${shown.length} worktree${plural(shown.length)} whose directory is gone (${shown.join(", ")})`,
              "Prune the metadata (`git worktree prune`). If one was moved, run `git worktree repair <new path>` instead.",
            ),
            {
              // A checkout moved somewhere doctor doesn't look loses its
              // link to the repo once pruned.
              prompt: `Prune git's record of ${shown.join(", ")} in ${project.name}? Say no if any of them was moved rather than deleted.`,
              label: `pruned git's worktree metadata for ${project.name}`,
              destructive: true,
              apply: prune(project),
            },
          ),
        );
      }
      if (drift.strays.length > 0) {
        const shown = drift.strays.map(collapseHome);
        entries.push(
          warn(
            "Projects",
            "project-strays",
            project.name,
            `${shown.length} ${pluralize(shown.length, "directory", "directories")} in the managed layout that git doesn't know about (${shown.join(", ")})`,
            `Adopt it (\`${binaryName} adopt <path>\`) or delete it by hand. ${binaryName} won't guess.`,
          ),
        );
      }
      return entries;
    });

  // Lifecycle scripts fail late and loudly, mid-create. A script naming
  // a file that isn't in the repo is the common cause, and checkable
  // without running anything.
  const checkProjectScripts = (
    project: ListedProject,
    settings: ConfigDoc | null,
  ) =>
    Effect.gen(function* () {
      if (settings === null) return [];
      const entries: Entry[] = [];
      for (const slot of ["setup", "teardown"] as const) {
        for (const { token, relative } of scriptFileTokens(
          scriptText(settings, slot),
        )) {
          if (!(yield* isMissing(path.join(project.path, relative)))) continue;
          entries.push(
            warn(
              "Projects",
              "project-scripts",
              project.name,
              `the ${slot} script runs ${token}, which isn't in the repo`,
              `Fix it with \`${binaryName} projects config --${slot} '<command>' -p ${project.name}\`.`,
            ),
          );
        }
      }
      return entries;
    });

  // .worktreeinclude drives carry-over into every new worktree. A broken
  // one doesn't fail create: it degrades to nothing carried over, which
  // looks like the feature is off.
  const checkWorktreeInclude = (
    project: ListedProject,
    settings: ConfigDoc | null,
  ) =>
    Effect.gen(function* () {
      const file = path.join(project.path, WORKTREE_INCLUDE);
      const info = yield* statOf(file);
      if (Option.isNone(info)) return [];
      if (info.value.type === "Directory") {
        return [
          warn(
            "Projects",
            "project-include",
            project.name,
            `${WORKTREE_INCLUDE} is a directory, so carry-over resolves nothing`,
            `Remove or replace ${collapseHome(file)}.`,
          ),
        ];
      }
      const readable = yield* fs
        .access(file, { readable: true })
        .pipe(Effect.result);
      if (Result.isFailure(readable)) {
        const reason = Predicate.isTagged(
          readable.failure.reason,
          "PermissionDenied",
        )
          ? "permission denied"
          : readable.failure.message;
        return [
          warn(
            "Projects",
            "project-include",
            project.name,
            `${WORKTREE_INCLUDE} can't be read (open ${file}: ${reason}), so nothing is carried into new worktrees`,
            `Fix the permissions on ${collapseHome(file)}.`,
          ),
        ];
      }
      // The integration is opt-out: absent means on.
      if (settings?.["useWorktreeInclude"] === false) return [];
      const listed = (exclude: string) =>
        git.run(project.path, [
          "ls-files",
          "-z",
          "--others",
          "--ignored",
          exclude,
          "--directory",
        ]);
      const resolved = yield* listed(`--exclude-from=${file}`).pipe(
        Effect.flatMap((candidates) =>
          candidates === "" ? Effect.void : listed("--exclude-standard"),
        ),
        Effect.result,
      );
      if (Result.isSuccess(resolved)) return [];
      const error = resolved.failure;
      return [
        warn(
          "Projects",
          "project-include",
          project.name,
          `${WORKTREE_INCLUDE} doesn't resolve: ${error instanceof Git.GitCommandError ? `git ${error.subcommand}: ${Git.stderrOf(error).trim()}` : error.message}`,
          "Check its patterns against `git ls-files --others`.",
        ),
      ];
    });

  // A carry-over entry no checkout has fails every create after the
  // worktree already exists.
  const checkCarryOver = (project: ListedProject, settings: ConfigDoc | null) =>
    Effect.gen(function* () {
      const entries = listOf(settings, "carryOver").map((entry) =>
        textAt(entry, "path"),
      );
      if (entries.length === 0) return [];
      const checkouts = yield* worktrees
        .identities(project)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<WorktreeIdentity> => []));
      const missing: string[] = [];
      for (const entry of entries) {
        let found = false;
        for (const checkout of checkouts) {
          if (Option.isSome(yield* statOf(path.join(checkout.path, entry)))) {
            found = true;
            break;
          }
        }
        if (!found) missing.push(entry);
      }
      const [first] = missing;
      if (first === undefined) return [];
      const n = missing.length;
      return [
        warn(
          "Projects",
          "project-carryover",
          project.name,
          `carry-over ${pluralize(n, "entry", "entries")} ${missing.join(", ")}${pluralize(n, " is", " are")} in no checkout, so new worktrees start without ${pluralize(n, "it", "them")}`,
          `Restore it in the primary checkout, or drop the entry (\`${binaryName} projects config carryover rm ${shellWord(first)} -p ${project.name}\`).`,
        ),
      ];
    });

  // Landing refs older than an hour. A ref has no timestamp, so its age
  // is the loose ref file's mtime. A packed one has been through a gc
  // and is old by definition. One in neither (reftable) is left alone.
  const staleIncomingRefs = (repo: string) =>
    Effect.gen(function* () {
      const listed = yield* git
        .run(repo, ["for-each-ref", "--format=%(refname)", INCOMING_PREFIX])
        .pipe(Effect.orElseSucceed(() => ""));
      if (listed.trim() === "") return [];
      const common = yield* git
        .run(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .pipe(Effect.option);
      if (Option.isNone(common)) return [];
      const commonDir = common.value.trim();
      const packed = Option.getOrElse(
        yield* readText(path.join(commonDir, "packed-refs")),
        () => "",
      );
      const now = yield* Clock.currentTimeMillis;
      const stale: string[] = [];
      for (const ref of fields(listed)) {
        const info = yield* statOf(path.join(commonDir, ref));
        if (Option.isSome(info)) {
          if (now - mtimeOf(info.value) >= INCOMING_REF_STALE_MS)
            stale.push(ref);
        } else if (packed.includes(` ${ref}\n`)) {
          stale.push(ref);
        }
      }
      return stale;
    });

  // refs/shigomori/incoming/<branch> is where a transfer lands a branch
  // before making the worktree, swept straight after. One that outlives
  // its landing blocks every later branch nested under its name.
  const checkIncomingRefs = (project: ListedProject) =>
    Effect.gen(function* () {
      const stale = yield* staleIncomingRefs(project.path);
      if (stale.length === 0) return [];
      const n = stale.length;
      const shown = stale.map((ref) => ref.slice(INCOMING_PREFIX.length));
      return [
        repairable(
          warn(
            "Projects",
            "project-incoming",
            project.name,
            `${n} transfer landing ref${plural(n)} left by an interrupted transfer (${shown.join(", ")}), which can block the next one`,
            `Delete ${pluralize(n, "it", "them")}. The commits stay on the device they came from.`,
          ),
          {
            prompt: `Delete ${stale.join(", ")} in ${project.name}?`,
            label: `deleted ${n} leftover landing ref${plural(n)} in ${project.name}`,
            destructive: true,
            apply: Effect.forEach(
              stale,
              (ref) =>
                git.run(project.path, [
                  "update-ref",
                  "-d",
                  "--end-of-options",
                  ref,
                ]),
              { discard: true },
            ),
          },
        ),
      ];
    });

  // Only problems, none for a healthy project.
  const checkOneProject = (project: ListedProject) =>
    Effect.gen(function* () {
      const repo = yield* checkProjectRepo(project);
      // Every check below needs a working repo.
      if (repo !== undefined) return repo;
      const stored = yield* config.read(projectScope(project));
      const settings = configured(stored);
      const entries: Entry[] = [];
      // The app and every command read a stored document with no default
      // branch as none, so its scripts and layout stop applying.
      if (stored !== null && settings === null) {
        entries.push(
          warn(
            "Projects",
            "project-config",
            project.name,
            "project.json exists but is invalid (bad JSON or no defaultBranch), so its scripts and layout are ignored",
            `Run \`${binaryName} projects config --default-branch <ref> -p ${project.name}\` to rewrite it.`,
          ),
        );
      }
      const override = textAt(settings, "defaultBranch");
      const primaryRef = yield* git.resolveDefaultBranch(
        project.path,
        override === "" ? undefined : override,
      );
      if (Option.isNone(primaryRef)) {
        entries.push(
          warn(
            "Projects",
            "project-branch",
            project.name,
            override.trim() !== ""
              ? `the configured default branch ${override.trim()} doesn't exist, and nothing else resolves either`
              : `no default branch resolves, so create has no base to fork from`,
            `Set one with \`${binaryName} projects config --default-branch <ref> -p ${project.name}\`.`,
          ),
        );
      }
      entries.push(
        ...(yield* checkProjectWorktrees(project)),
        ...(yield* checkProjectScripts(project, settings)),
        ...(yield* checkWorktreeInclude(project, settings)),
        ...(yield* checkCarryOver(project, settings)),
        ...(settings === null
          ? []
          : yield* launcherFindings(
              "Projects",
              "project-launchers",
              project.name,
              launcherCommands(settings),
              "projects config launcher rm",
              ` -p ${project.name}`,
            )),
        ...(yield* checkIncomingRefs(project)),
      );
      return entries;
    });

  // One line per healthy project and one per problem otherwise, so a
  // dozen projects don't bury the findings under green ticks. A terrier
  // project gets the same checks, all but the unregister repair.
  const checkProjects = (projects: ReadonlyArray<ListedProject>) =>
    Effect.map(
      Effect.forEach(projects, checkOneProject, { concurrency: "unbounded" }),
      (found) =>
        found.flatMap((entries, index) => {
          const project = projects[index];
          if (entries.length > 0 || project === undefined) return entries;
          const via =
            project.source === undefined ? "" : ` (via ${project.source})`;
          return [ok("Projects", "project", project.name, `ok${via}`)];
        }),
    );

  // --- the run ---

  // The registry's projects, then terrier's, as every command sees them.
  // A terrier listing that failed leaves the list short, so the checks
  // that read "nothing claims this" as a leftover stand down.
  const listProjects = Effect.gen(function* () {
    const registered = yield* registry.projects;
    const listing = yield* terrier.listing;
    const extras = terrierProjects(
      new Set(registered.map(({ path: at }) => at)),
      listing.paths,
    );
    return {
      projects: [...registered, ...extras] as ReadonlyArray<ListedProject>,
      complete: Option.isNone(listing.trouble),
    };
  });

  const checkAll = (input: {
    readonly version: string;
    readonly executable: string;
    readonly terminal: boolean;
  }) =>
    Effect.gen(function* () {
      const { projects, complete } = yield* listProjects;
      const environment = [
        ...(yield* checkGit),
        ...(yield* checkGh),
        ...(yield* checkApp(input.version, input.executable)),
        ...(yield* checkPath),
        ...(yield* checkShellHook(input.terminal)),
      ];
      const dir = yield* checkDataDir;
      const dataDirGroup = dir.usable
        ? [
            ...dir.entries,
            ...(yield* checkGlobalConfig),
            ...(yield* checkRegistry),
            ...(yield* checkStaleLocks),
            ...(yield* checkStagingLock),
            ...(yield* checkUpdateLeftovers(input.version)),
            ...(yield* checkPortAllocations),
            ...(yield* checkGlobalLaunchers),
            ...(yield* checkTerrier),
            ...(yield* checkDormantState(projects, complete)),
          ]
        : dir.entries;
      const all = [
        ...environment,
        ...dataDirGroup,
        ...(yield* checkOrphanTunnel),
        ...(yield* checkOrphanScripts),
        ...(yield* checkProjects(projects)),
        ...(dir.usable ? yield* checkBookkeeping(projects, complete) : []),
      ];
      // Group order, stable within a group: the bookkeeping line runs
      // last and prints under the data dir.
      return all.toSorted(
        (a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group),
      );
    }).pipe(Effect.provideContext(platform));

  const run = Effect.fn("Doctor.run")(function* (input: {
    readonly version: string;
    readonly executable: string;
    readonly terminal: boolean;
    readonly fix?: {
      readonly approve: (repair: Repair) => Effect.Effect<boolean>;
    };
  }) {
    let entries = yield* checkAll(input);
    const repaired: string[] = [];
    const repairFailed: string[] = [];
    if (input.fix !== undefined) {
      for (const { repair } of entries) {
        if (repair === undefined) continue;
        const { apply, ...asked } = repair;
        if (repair.destructive && !(yield* input.fix.approve(asked))) continue;
        const outcome = yield* Effect.result(apply);
        if (Result.isFailure(outcome)) {
          repairFailed.push(
            `couldn't ${repair.label}: ${repairMessage(outcome.failure)}`,
          );
        } else {
          repaired.push(repair.label);
        }
      }
      // The document describes the world after the repairs.
      if (repaired.length > 0) entries = yield* checkAll(input);
    }
    const summary = counts(entries);
    return {
      ok: summary.fail === 0,
      dataDir,
      flavor,
      version: input.version,
      binary: binaryName,
      summary,
      repaired,
      repairFailed,
      checks: entries.map(findingOf),
    };
  });

  return Doctor.of({ run });
});

export const layer = Layer.effect(Doctor, make);
