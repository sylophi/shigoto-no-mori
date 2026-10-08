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
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { WORKTREE_INCLUDE } from "./CarryOver.ts";
import * as CloneCheckout from "./CloneCheckout.ts";
import * as Config from "./Config.ts";
import { projectSettingsOf, storedProblem } from "./Config.ts";
import type { ConfigDoc } from "./configDoc.ts";
import {
  atoi,
  belowGitFloor,
  compareVersions,
  fields,
  findHookSpan,
  fishHookContent,
  formatSize,
  hookBeginMarker,
  hookBlock,
  type HookNames,
  launcherProgram,
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
import { envVar } from "./environment.ts";
import { findExecutable } from "./executables.ts";
import { flavorNames } from "./flavor.ts";
import * as Darwin from "./Darwin.ts";
import * as Git from "./Git.ts";
import { appFoldersOf, decodedLaunchers } from "./Launchers.ts";
import * as Layout from "./Layout.ts";
import * as Paths from "./Paths.ts";
import { errnoText, isNotFound } from "./platformErrors.ts";
import { pidAlive } from "./processes.ts";
import * as Registry from "./Registry.ts";
import {
  acquireStagingLock,
  StagingLockUnavailable,
  stagingHolder,
  stagingLockPath,
  UpdateInProgress,
} from "./stagingLock.ts";
import type { ListedProject, RegisteredProject } from "./Registry.ts";
import * as Terrier from "./Terrier.ts";
import { terrierProjects } from "./Terrier.ts";
import * as WorktreeData from "./WorktreeData.ts";
import { worktreeIdFromPath } from "./worktreeLayout.ts";
import * as Worktrees from "./Worktrees.ts";
import { scriptOf, type WorktreeIdentity } from "./Worktrees.ts";

// --- the document ---------------------------------------------------------

export type Status = "ok" | "warn" | "fail";

// The groups in the order they print: broadest blast radius first.
export type Group = "Environment" | "Data dir" | "Processes" | "Projects";

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

export type RunInput = {
  // This build's version, which the app bundle and the update files are
  // compared against.
  readonly version: string;
  // The running binary, which a prod build expects inside the app.
  readonly executable: string;
  // Whether a person is at a terminal, which makes a shell hook that
  // isn't active in this session worth a word.
  readonly terminal: boolean;
  // Apply the repairs, a destructive one only once `approve` says yes.
  readonly fix?: {
    readonly approve: (repair: Repair) => Effect.Effect<boolean>;
  };
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

type RepairError =
  | Git.GitError
  | PlatformError.PlatformError
  | MovedWorktreePending
  | UpdateInProgress
  | StagingLockUnavailable;

export class Doctor extends Context.Service<
  Doctor,
  {
    // Every check, in the order the checklist prints. With `fix`, the
    // repairs the findings offer run in that order and the checks run
    // again, so the document describes the world after them. A failed
    // repair is reported and the rest still run.
    readonly run: (input: RunInput) => Effect.Effect<DoctorDocument>;
  }
>()("sm/engine/Doctor") {}

// --- helpers --------------------------------------------------------------

type Entry = Finding & {
  readonly repair?: Repair & {
    readonly apply: Effect.Effect<void, RepairError>;
  };
};

// One check's lines, by its group, id and title.
const check = (group: Group, id: string, title: string) => ({
  ok: (detail: string): Entry => ({ group, id, title, status: "ok", detail }),
  warn: (detail: string, fix: string): Entry => ({
    group,
    id,
    title,
    status: "warn",
    detail,
    fix,
  }),
  fail: (detail: string, fix: string): Entry => ({
    group,
    id,
    title,
    status: "fail",
    detail,
    fix,
  }),
});

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

// What a failure says, git's own words for a git that failed.
const errorText = (error: { readonly message: string }) =>
  error instanceof Git.GitCommandError
    ? `git ${error.subcommand}: ${Git.stderrOf(error).trim()}`
    : error.message;

const isDirMode = (mode: number) => (mode & Darwin.S_IFMT) === Darwin.S_IFDIR;

// A stat's mtime, epoch ms.
const lstatMtime = (entry: Darwin.LstatEntry) =>
  entry.mtimeSec * 1000 + Math.floor(entry.mtimeNsec / 1e6);

// Who holds the update stager's pidfile, read once a pass.
type Holder = Effect.Success<ReturnType<typeof stagingHolder>>;

const mtimeOf = (info: FileSystem.File.Info) =>
  Option.match(info.mtime, {
    onNone: () => 0,
    onSome: (date) => date.getTime(),
  });

// A lock older than this belonged to a process that died holding it:
// the writes they guard take milliseconds.
const LOCK_STALE_MS = 10_000;
// A transfer's landing ref older than this can only be a leftover: a
// landing sweeps it within seconds.
const INCOMING_REF_STALE_MS = 60 * 60 * 1000;
// ps reports a start time to the second, stamped just after spawn.
const SCRIPT_START_TOLERANCE_MS = 5_000;

const APP_NAME = "Shigoto no Mori";
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

const textAt = (doc: Readonly<Record<string, unknown>> | null, key: string) => {
  const value = doc?.[key];
  return typeof value === "string" ? value : "";
};

// The carry-over entries' paths, every entry the settings list, as Go
// checks them: one create would skip still fails the check.
const carryOverPaths = (settings: ConfigDoc | null) => {
  const value = settings?.["carryOver"];
  return Array.isArray(value)
    ? value.filter(Predicate.isObject).map((entry) => textAt(entry, "path"))
    : [];
};

const launcherCommands = (doc: ConfigDoc | null) =>
  decodedLaunchers(doc).custom.map(({ label, command }) => ({
    label: label ?? "",
    command: command ?? "",
  }));

// What a project's checks found, and its checkouts when they could be
// listed, which the bookkeeping line reads again.
type ProjectChecked = {
  readonly entries: ReadonlyArray<Entry>;
  readonly identities: Option.Option<ReadonlyArray<WorktreeIdentity>>;
};

// The state a shell's hook is in: ours and current or an older vintage,
// absent, or edited past recognizing.
type Hook =
  | { readonly state: "missing" }
  | { readonly state: "modified" }
  | { readonly state: "installed"; readonly current: boolean };

// --- the service ----------------------------------------------------------

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const paths = yield* Paths.Paths;
  const config = yield* Config.Config;
  const git = yield* Git.Git;
  const layout = yield* Layout.Layout;
  const registry = yield* Registry.Registry;
  const terrier = yield* Terrier.Terrier;
  const worktrees = yield* Worktrees.Worktrees;
  const data = yield* WorktreeData.WorktreeData;
  const cloneCheckout = yield* CloneCheckout.CloneCheckout;
  const darwin = yield* Darwin.Darwin;
  const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

  const { home, dataDir, binaryName, flavor, configHome } = paths;
  const names = flavorNames(flavor);
  const hookNames: HookNames = { binary: binaryName, alias: names.alias };
  // Read once, as Paths reads the environment.
  const zdotdir = yield* envVar("ZDOTDIR");
  // The shell wrapper's directive file, set while the hook is active.
  const cdFile = yield* envVar("SHIGOMORI_CD_FILE");

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
    env?: Record<string, string>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(command, [...args], {
            stdin: "ignore",
            ...(env === undefined ? {} : { env, extendEnv: true }),
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

  // lstat(2) of names in a folder, by name: a symlink's own, as Go's
  // directory entries tell them. What it can't answer is absent.
  const lstatIn = (dir: string, entries: ReadonlyArray<string>) =>
    entries.length === 0
      ? Effect.succeed(new Map<string, Darwin.LstatEntry>())
      : darwin.lstat({ root: dir, paths: entries }).pipe(
          Stream.runCollect,
          Effect.map(
            (found) =>
              new Map(
                found.flatMap((entry) =>
                  Darwin.isFailed(entry) ? [] : [[entry.path, entry] as const],
                ),
              ),
          ),
          Effect.orElseSucceed(() => new Map<string, Darwin.LstatEntry>()),
        );

  const statOf = (target: string) => fs.stat(target).pipe(Effect.option);

  const isDirectory = (target: string) =>
    Effect.map(
      statOf(target),
      (info) => Option.isSome(info) && info.value.type === "Directory",
    );

  const isFile = (target: string) =>
    Effect.map(
      statOf(target),
      (info) => Option.isSome(info) && info.value.type === "File",
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

  const listDir = (dir: string) =>
    fs
      .readDirectory(dir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

  // --- environment ---

  const checkGit = Effect.gen(function* () {
    const line = check("Environment", "git", "git");
    const version = yield* git.run(home, ["--version"]).pipe(Effect.option);
    if (Option.isNone(version)) {
      return line.fail(
        "not runnable (every command in sm shells out to it)",
        "Install git (`xcode-select --install`) and make sure it's on PATH.",
      );
    }
    const trimmed = version.value.trim();
    const raw = (
      trimmed.startsWith("git version ")
        ? trimmed.slice("git version ".length)
        : trimmed
    ).trim();
    const parsed = parseGitVersion(raw);
    if (parsed !== undefined && belowGitFloor(parsed.major, parsed.minor)) {
      return line.warn(
        `${raw} is older than 2.40, which sm's worktree creation needs`,
        "Upgrade git (`brew upgrade git`).",
      );
    }
    return line.ok(raw);
  });

  const checkGh = Effect.gen(function* () {
    const line = check("Environment", "gh", "gh");
    if (Option.isNone(yield* findExecutable("gh"))) {
      return line.warn(
        "not on PATH, so pr, merge, and land can't talk to GitHub without it",
        "Install the GitHub CLI (`brew install gh`), then `gh auth login`.",
      );
    }
    // Only success matters: `gh auth status` prints account details that
    // have no business in sm's output.
    const auth = yield* capture("gh", ["auth", "status"]).pipe(Effect.option);
    if (Option.isNone(auth) || auth.value.code !== 0) {
      return line.warn(
        "installed but not authenticated",
        "Run `gh auth login`.",
      );
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
    return line.ok(`${shown}, authenticated`);
  });

  const appRoots = appFoldersOf(path, home);

  // The prod binary runs from <bundle>/Contents/Resources (the PATH
  // command is a symlink there), so its bundle is two folders up.
  const installedBundle = (executable: string) =>
    Effect.map(realPath(executable), (resolved) => {
      const resources = path.dirname(
        Option.getOrElse(resolved, () => executable),
      );
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
      const [aside] = (yield* listDir(root))
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
  const checkApp = ({ version, executable }: RunInput) =>
    Effect.gen(function* () {
      const line = check("Environment", "app", "app");
      if (flavor !== "prod") {
        return line.ok(
          `dev build (${binaryName} ${version}): runs from a checkout, no installed bundle`,
        );
      }
      const bundle = yield* installedBundle(executable);
      if (Option.isNone(bundle)) {
        const found = yield* findInstalledBundle;
        if (Option.isSome(found)) {
          return line.warn(
            `this binary isn't the one inside ${collapseHome(found.value)}, so \`${binaryName} update\` can't reach it`,
            `Re-link the CLI from the app's Settings, or run ${collapseHome(path.join(found.value, "Contents", "Resources", binaryName))}.`,
          );
        }
        const aside = yield* findAsideBundle;
        if (Option.isSome(aside)) {
          return line.fail(
            `the app is missing, but ${collapseHome(aside.value)} is the copy an interrupted update set aside`,
            `Rename it back to ${APP_NAME}.app.`,
          );
        }
        return line.warn(
          "no installed app bundle found, so update, app, and the port-pool toggle have nothing behind them",
          "Install Shigoto no Mori, or use the dev CLI (smd) against a checkout.",
        );
      }
      const appVersion = yield* bundleVersion(bundle.value);
      if (appVersion === "") {
        return line.warn(
          `${collapseHome(bundle.value)} has no readable version in Info.plist`,
          "Reinstall the app.",
        );
      }
      if (appVersion !== version) {
        return line.warn(
          `app is ${appVersion} but this CLI is ${version}. They ship together, so one of them is stale`,
          `Run \`${binaryName} update\`, or re-link the CLI from the app's Settings.`,
        );
      }
      return line.ok(`${appVersion} at ${collapseHome(bundle.value)}`);
    });

  // The binary in PATH order, deduped by the file each entry resolves
  // to, so a symlink and its target don't read as a conflict.
  const binariesOnPath = Effect.gen(function* () {
    const searched = yield* envVar("PATH");
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
    const line = check("Environment", "path", "PATH");
    const found = yield* binariesOnPath;
    const [first] = found;
    if (first === undefined) {
      return line.warn(
        `no \`${binaryName}\` on PATH, so this run came from an explicit path`,
        "Link the CLI from the app's Settings, or add its directory to PATH.",
      );
    }
    if (found.length === 1) return line.ok(first);
    return line.warn(
      `${found.length} different \`${binaryName}\` binaries on PATH; ${first} wins`,
      `Remove the shadowed copies (${found.slice(1).join(", ")}) or reorder PATH.`,
    );
  });

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
      const text = yield* fs.readFileString(yield* hookPath(kind)).pipe(
        Effect.asSome,
        Effect.catchIf(isNotFound, () => Effect.succeed(Option.none<string>())),
        // Unreadable isn't absent: hands off.
        Effect.orElseSucceed(() => undefined),
      );
      if (text === undefined) return { state: "modified" } satisfies Hook;
      if (Option.isNone(text)) return { state: "missing" } satisfies Hook;
      if (kind === "fish") {
        return text.value.includes(hookBeginMarker(hookNames))
          ? ({
              state: "installed",
              current: text.value === fishHookContent(hookNames),
            } satisfies Hook)
          : ({ state: "modified" } satisfies Hook);
      }
      const lines = text.value.split("\n");
      const span = findHookSpan(hookNames, lines);
      if (span.kind === "none") return { state: "missing" } satisfies Hook;
      if (span.kind === "broken" || !span.ours) {
        return { state: "modified" } satisfies Hook;
      }
      return {
        state: "installed",
        current:
          lines.slice(span.begin, span.end + 1).join("\n") ===
          hookBlock(hookNames, kind).replace(/\n+$/, ""),
      } satisfies Hook;
    });

  // Installed and current: install refreshes the block in place, so one
  // from an older vintage was written by a build whose guard line has
  // since changed.
  const checkShellHook = (terminal: boolean) =>
    Effect.gen(function* () {
      const line = check("Environment", "shell-hook", "shell hook");
      const installed: ShellKind[] = [];
      const edited: ShellKind[] = [];
      const stale: ShellKind[] = [];
      for (const kind of SHELL_KINDS) {
        const hook: Hook = yield* inspectHook(kind);
        if (hook.state === "installed") {
          installed.push(kind);
          if (!hook.current) stale.push(kind);
        } else if (hook.state === "modified") {
          edited.push(kind);
        }
      }
      if (edited.length > 0) {
        return line.warn(
          `the block in ${edited.join(", ")}'s config was edited, so install and uninstall won't touch it`,
          `Restore or remove the marker block, then \`${binaryName} shell install\`.`,
        );
      }
      if (stale.length > 0) {
        return line.warn(
          `the ${stale.join(", ")} hook is an older vintage than this build writes`,
          `Run \`${binaryName} shell install\` to refresh it.`,
        );
      }
      if (installed.length === 0) {
        return line.warn(
          "not installed, so cd and create open a subshell instead of moving your shell",
          `Run \`${binaryName} shell install\`.`,
        );
      }
      // "This session" is a terminal's. Without one (the app's read) it
      // would always read as a problem.
      const inactive = terminal && cdFile === "";
      return line.ok(
        `installed for ${installed.join(", ")}${inactive ? " (not active in this session)" : ""}`,
      );
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

  const dataDirLine = check("Data dir", "data-dir", "data dir");

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
        (yield* paths.holdsState(other)) !== "present"
      ) {
        return Option.none<Entry>();
      }
      return Option.some(
        dataDirLine.warn(
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
    if (paths.dataDirSource === "default" && Option.isSome(paths.pointer)) {
      const { file, target, problem } = paths.pointer.value;
      if (target !== "" && problem !== "") {
        return {
          entry: dataDirLine.warn(
            `the pointer file names ${target}, which was ignored because ${problem}, so sm is using ${shown}`,
            `Fix ${collapseHome(file)} to name a data dir, or delete it.`,
          ),
          usable: yield* isDirectory(dataDir),
        };
      }
    }
    const info = yield* fs.stat(dataDir).pipe(Effect.result);
    if (Result.isFailure(info) && isNotFound(info.failure)) {
      const addProject = `\`${binaryName} projects add\``;
      if (paths.dataDirSource !== "pointer") {
        return {
          entry: dataDirLine.warn(
            `${collapseHome(dataDir)} doesn't exist yet (${sourceText}), so nothing is registered`,
            `Add a project (${addProject}) and it will be created.`,
          ),
          usable: false,
        };
      }
      const file = collapseHome(
        Option.match(paths.pointer, {
          onNone: () => "",
          onSome: (pointer) => pointer.file,
        }),
      );
      const volume = yield* unmountedVolume(dataDir);
      return {
        entry:
          volume !== ""
            ? dataDirLine.fail(
                `the pointer file names ${dataDir}, on ${volume}, which isn't connected`,
                `Connect the drive. To start over on this Mac instead, delete ${file}.`,
              )
            : dataDirLine.warn(
                `${collapseHome(dataDir)} doesn't exist yet (${sourceText}), so nothing is registered`,
                `If the data was moved or deleted, fix or delete ${file}. Otherwise add a project (${addProject}) and it will be created.`,
              ),
        usable: false,
      };
    }
    if (Result.isFailure(info)) {
      return {
        entry: dataDirLine.fail(
          `${collapseHome(dataDir)} can't be read: ${info.failure.message}`,
          `Check the permissions on ${collapseHome(dataDir)}.`,
        ),
        usable: false,
      };
    }
    if (info.success.type !== "Directory") {
      return {
        entry: dataDirLine.fail(
          `${collapseHome(dataDir)} is a file, not a directory (${sourceText})`,
          "Move it aside, or point SHIGOMORI_DATA_DIR somewhere else.",
        ),
        usable: false,
      };
    }
    const writable = yield* fs.access(dataDir, { writable: true }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (!writable) {
      return {
        entry: dataDirLine.fail(
          `${collapseHome(dataDir)} isn't writable, so no command that changes state can work`,
          "Fix its ownership or permissions.",
        ),
        usable: true,
      };
    }
    if (paths.dataDirSource === "legacy") {
      return {
        entry: dataDirLine.warn(
          shown,
          `Rename it to ~/${names.dataDir} from the app's Settings > Data location.`,
        ),
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
      entry: Option.getOrElse(ignored, () => dataDirLine.ok(shown)),
      usable: true,
    };
  });

  const configFile = path.join(dataDir, "config.json");
  const registryFile = path.join(dataDir, "registry.json");

  // The device's settings, each value checked against the key it sets.
  const checkGlobalConfig = (device: ConfigDoc) => {
    const line = check("Data dir", "config", "config.json");
    const keys = Object.keys(device).length;
    if (keys === 0) return line.ok("absent, so defaults apply");
    if (storedProblem({ kind: "device" }, device) !== undefined) {
      return line.warn(
        "parses, but a field has the wrong type and is being dropped",
        `Check ${collapseHome(configFile)} against the app's Settings.`,
      );
    }
    return line.ok(`valid, ${keys} key${plural(keys)}`);
  };

  const checkRegistry = Effect.gen(function* () {
    const line = check("Data dir", "registry", "registry.json");
    const projects = yield* registry.projects;
    const malformed = projects.filter(
      (project) => project.id === "" || project.path === "",
    ).length;
    if (malformed > 0) {
      return line.warn(
        `${malformed} registry ${pluralize(malformed, "entry is", "entries are")} missing an id or path`,
        `Remove the incomplete entries from ${collapseHome(registryFile)}.`,
      );
    }
    return line.ok(
      `valid, ${projects.length} project${plural(projects.length)} registered`,
    );
  });

  // Lock files under the data dir older than a write can take: the
  // data dir itself, each project's folder and its worktrees folder,
  // and iconCache/. updates/ holds downloads, never a lock.
  const findStaleLocks = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const stale: string[] = [];
    const scan = (dir: string) =>
      Effect.gen(function* () {
        const locks = (yield* listDir(dir)).filter((name) =>
          name.endsWith(".lock"),
        );
        for (const [name, entry] of yield* lstatIn(dir, locks)) {
          if (
            !isDirMode(entry.mode) &&
            now - lstatMtime(entry) > LOCK_STALE_MS
          ) {
            stale.push(path.join(dir, name));
          }
        }
      });
    yield* scan(dataDir);
    yield* scan(path.join(dataDir, "iconCache"));
    const projectsDir = path.join(dataDir, "projects");
    for (const [name, entry] of yield* lstatIn(
      projectsDir,
      yield* listDir(projectsDir),
    )) {
      if (!isDirMode(entry.mode)) continue;
      const dir = path.join(projectsDir, name);
      yield* scan(dir);
      yield* scan(path.join(dir, "worktrees"));
    }
    return stale.toSorted();
  });

  const removeIfPresent = (target: string) =>
    fs.remove(target).pipe(Effect.catchIf(isNotFound, () => Effect.void));

  const checkStaleLocks = Effect.gen(function* () {
    const line = check("Data dir", "locks", "locks");
    const locks = yield* findStaleLocks;
    const [first] = locks;
    if (first === undefined) return line.ok("no stale lock files");
    const label = `${locks.length} stale lock file${plural(locks.length)}`;
    const extra = locks.length - 1;
    return repairable(
      line.warn(
        `${collapseHome(first)} has been held for longer than a write can take${extra > 0 ? ` (and ${extra} more)` : ""}`,
        "Delete it. The process that took it is gone.",
      ),
      {
        prompt: `Delete ${label} (${locks.map(collapseHome).join(", ")})?`,
        label: `deleted ${label}`,
        destructive: true,
        apply: Effect.forEach(locks, removeIfPresent, { discard: true }),
      },
    );
  });

  const updatesDir = path.join(dataDir, "updates");
  const stagingLock = stagingLockPath(path, dataDir);
  const stagedDir = path.join(updatesDir, "staged");

  // The stager holds its pidfile for a whole download, so a crashed one
  // is told by its pid being dead, not by the file's age.
  const checkStagingLock = (holder: Holder) => {
    const line = check("Data dir", "staging-lock", "update staging");
    if (Option.isNone(holder)) return [];
    const { pid, alive } = holder.value;
    if (alive) return [line.ok(`in progress (pid ${pid})`)];
    return [
      repairable(
        line.warn(
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
  };

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
      const staged = Option.flatMap(
        yield* readText(path.join(stagedDir, "manifest.json")),
        Schema.decodeOption(StagedManifest),
      );
      const stagedVersion = Option.isSome(staged)
        ? parseSemver(staged.value.version ?? "")
        : undefined;
      const current = parseSemver(version);
      if (
        stagedVersion !== undefined &&
        current !== undefined &&
        compareVersions(stagedVersion, current) <= 0
      ) {
        found.push(stagedDir);
      }
      return found;
    });

  // The bytes of the files under a path, the path itself when a file.
  // A symlink counts as itself, never what it points at.
  const treeSize = (root: string) =>
    darwin.lstat({ root }).pipe(
      Stream.runFold(
        () => 0,
        (size, entry) =>
          Darwin.isFailed(entry) || isDirMode(entry.mode)
            ? size
            : size + entry.size,
      ),
      Effect.orElseSucceed(() => 0),
    );

  // A crashed or superseded update leaves its scratch until the next
  // update sweeps it. Only while no stager holds the lock: mid-run,
  // these are its working files.
  const checkUpdateLeftovers = (version: string, holder: Holder) =>
    Effect.gen(function* () {
      if (Option.isSome(holder) && holder.value.alive) return [];
      const found = yield* updateLeftovers(version);
      if (found.length === 0) return [];
      let size = 0;
      for (const item of found) size += yield* treeSize(item);
      const shown = formatSize(size);
      return [
        repairable(
          check("Data dir", "update-leftovers", "update files").warn(
            `${shown} of downloads left by an earlier update that nothing will install`,
            "Delete them, or let the next update sweep them.",
          ),
          {
            prompt: `Delete ${shown} of leftover update files in ${collapseHome(updatesDir)}?`,
            label: `deleted ${shown} of leftover update files`,
            destructive: true,
            // Under the stager's own lock, and listed again once it is
            // held: a run that staged something newer since keeps it.
            apply: Effect.gen(function* () {
              yield* acquireStagingLock(stagingLock);
              for (const item of yield* updateLeftovers(version)) {
                yield* fs.remove(item, { recursive: true });
              }
            }).pipe(Effect.scoped, Effect.provideContext(platform)),
          },
        ),
      ];
    });

  // port-pool leases are keyed by directory and live in port-pool's own
  // state. One whose directory is gone stays reserved forever. Reported,
  // never fixed: the state belongs to port-pool.
  const checkPortAllocations = (device: ConfigDoc) =>
    Effect.gen(function* () {
      if (device["portPool"] !== true) return [];
      const line = check("Data dir", "ports", "port pool");
      if (Option.isNone(yield* findExecutable("port-pool"))) {
        return [
          line.warn(
            "enabled in config.json but `port-pool` isn't on PATH, so provisioning is skipped",
            "Install port-pool, or turn the toggle off in the app's Settings.",
          ),
        ];
      }
      const listed = yield* capture("port-pool", ["list"]).pipe(Effect.result);
      if (Result.isFailure(listed) || listed.success.code !== 0) {
        const why = Result.isFailure(listed)
          ? listed.failure.message
          : `exit status ${listed.success.code}`;
        return [
          line.warn(
            `\`port-pool list\` failed: ${why}`,
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
          line.ok(
            `${dirs.length} allocation${plural(dirs.length)}, all pointing at directories that exist`,
          ),
        ];
      }
      return [
        line.warn(
          `${orphans} of ${dirs.length} allocations point at directories that are gone, so those ports stay reserved`,
          `Run \`port-pool prune\` (it owns that state, so ${binaryName} won't touch it).`,
        ),
      ];
    });

  // Custom launchers fire and forget through /bin/sh, so one whose
  // program isn't installed fails with nothing on screen.
  const launcherFindings = (
    line: ReturnType<typeof check>,
    doc: ConfigDoc | null,
    rm: string,
    scope: string,
  ) =>
    Effect.gen(function* () {
      const entries: Entry[] = [];
      for (const { label, command } of launcherCommands(doc)) {
        const program = launcherProgram(command, paths.expandHome);
        if (program === "") continue;
        const present = program.startsWith("/")
          ? Option.isSome(yield* statOf(program))
          : Option.isSome(yield* findExecutable(program));
        if (present) continue;
        entries.push(
          line.warn(
            `the ${label} launcher runs ${program}, which isn't installed or on PATH`,
            `Install it, or fix the launcher (\`${binaryName} ${rm} ${shellWord(label)}${scope}\`, then add it again).`,
          ),
        );
      }
      return entries;
    });

  // Terrier's registry is terrier's, and sm only merges it in, so this
  // says why merged projects might be missing.
  const checkTerrier = (device: ConfigDoc, listing: Terrier.TerrierListing) => {
    if (device["terrier"] !== true) return [];
    const line = check("Data dir", "terrier", "terrier");
    if (Option.isSome(listing.trouble)) {
      const { summary, advice } = listing.trouble.value;
      return [line.warn(summary, advice)];
    }
    const count = listing.paths.length;
    return [
      line.ok(
        `${count} registered repo${plural(count)} merged into the project list`,
      ),
    ];
  };

  // A project's state that no listed project claims is dormant: terrier
  // rm of a repo sm held settings for leaves it, since the id is all
  // that ties it to a path. Re-registering the path under terrier brings
  // back the same id and picks it up again, so dropping it asks first.
  const checkDormantState = (
    projects: ReadonlyArray<ListedProject>,
    complete: boolean,
    kept: ReadonlyArray<{ readonly projectId: string }>,
  ) =>
    Effect.gen(function* () {
      if (!complete) return [];
      const stored = new Set([
        ...(yield* config.storedProjectIds),
        ...kept.map(({ projectId }) => projectId),
      ]);
      if (stored.size === 0) return [];
      const line = check("Data dir", "dormant-state", "project state");
      const claimed = new Set(projects.map(({ id }) => id));
      const dormant = [...stored].filter((id) => !claimed.has(id)).toSorted();
      const [first] = dormant;
      if (first === undefined) {
        return [
          line.ok(
            `${stored.size} state dir${plural(stored.size)}, each belonging to a project`,
          ),
        ];
      }
      const n = dormant.length;
      const extra = n - 1;
      const label = `${n} dormant project state${plural(n)}`;
      return [
        repairable(
          line.warn(
            `${n} state ${pluralize(n, "dir belongs", "dirs belong")} to no project (${first}${extra > 0 ? ` and ${extra} more` : ""})`,
            "Harmless: it reconnects if terrier lists the repo again (re-added, or the terrier toggle back on). Otherwise delete it.",
          ),
          {
            prompt: `Delete ${label} (${dormant.join(", ")})? Its settings and worktree titles go.`,
            label: `deleted ${label}`,
            destructive: true,
            apply: Effect.forEach(
              dormant,
              (id) =>
                Effect.andThen(
                  config.forgetProject(id),
                  data.forgetProject(id),
                ),
              { discard: true },
            ),
          },
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
    listed: ReadonlyMap<string, ReadonlyArray<WorktreeIdentity>>,
    kept: ReadonlyArray<{
      readonly projectId: string;
      readonly worktreeId: string;
    }>,
  ) =>
    Effect.gen(function* () {
      if (!complete) return [];
      const known = new Set<string>();
      const idsOf = new Map<string, ReadonlySet<string>>();
      for (const project of projects) {
        const found = Option.fromUndefinedOr(listed.get(project.id));
        // A project whose checks stopped early is listed here.
        const identities = Option.isSome(found)
          ? found
          : yield* worktrees.identities(project).pipe(Effect.option);
        // An unreadable repo would make every id look orphaned.
        if (Option.isNone(identities)) return [];
        const ids = new Set(identities.value.map(({ id }) => id));
        for (const id of ids) known.add(id);
        idsOf.set(project.id, ids);
      }
      const dataFiles = kept.filter(({ projectId, worktreeId }) => {
        const ids = idsOf.get(projectId);
        return ids !== undefined && !ids.has(worktreeId);
      }).length;
      const sets: ReadonlyArray<ReadonlySet<string>> = [
        yield* registry.marked("shelved"),
        yield* registry.marked("autoPull"),
        yield* registry.marked("agentWorking"),
        yield* worktrees.snapshotted,
      ];
      const marked = new Set<string>();
      let leftover = 0;
      for (const set of sets) {
        for (const id of set) {
          marked.add(id);
          if (!known.has(id)) leftover++;
        }
      }
      const line = check("Data dir", "bookkeeping", "worktree marks");
      if (leftover === 0 && dataFiles === 0) {
        return marked.size > 0
          ? [
              line.ok(
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
        line.warn(
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
    const output = ps.value.stdout.trim();
    const space = output.indexOf(" ");
    const ppid = space < 0 ? output : output.slice(0, space);
    const comm = space < 0 ? "" : output.slice(space + 1);
    // Reparented to launchd is what outliving the app looks like. With
    // the app alive it is the app's child, and the app's business.
    if (!comm.toLowerCase().includes("cloudflared") || ppid.trim() !== "1") {
      return [];
    }
    return [
      check("Processes", "tunnel", "tunnel").warn(
        `a cloudflared tunnel (pid ${pid}) outlived the app that started it, so this Mac stays reachable through it`,
        `Open the app, which stops it at launch, or run \`kill ${pid}\`.`,
      ),
    ];
  });

  // The dev servers and scripts the app started outlive a crashed app
  // until its next launch stops them, holding their ports.
  const checkOrphanScripts = Effect.gen(function* () {
    const file = Option.flatMap(
      yield* readText(path.join(dataDir, "running-scripts.json")),
      Schema.decodeOption(RunningScripts),
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
      { LC_ALL: "C" },
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
      check("Processes", "scripts", "scripts").warn(
        `${n} script${plural(n)} the app started ${pluralize(n, "is", "are")} still running after it quit (${orphans.map(({ command }) => command ?? "").join(", ")}), holding ${pluralize(n, "its", "their")} ports`,
        `Open the app, which stops them at launch, or run \`kill ${orphans.map(({ pid }) => String(pid ?? 0)).join(" ")}\`.`,
      ),
    ];
  });

  // --- projects ---

  const unregisterHint = (project: ListedProject) =>
    project.source === "terrier"
      ? `\`terrier rm ${project.name}\``
      : `\`${binaryName} projects remove ${project.name}\``;

  // Whether the project's path is a working repo, which every other
  // check needs: its common dir when it is, what is wrong when it isn't.
  const checkProjectRepo = (project: ListedProject) =>
    Effect.gen(function* () {
      const info = yield* fs.stat(project.path).pipe(Effect.result);
      if (Result.isFailure(info) && isNotFound(info.failure)) {
        const line = check("Projects", "project-path", project.name);
        if (project.source !== undefined) {
          // Not sm's entry to drop: terrier prune owns it.
          return Result.fail(
            line.warn(
              `${collapseHome(project.path)} is gone, but ${project.source} still lists it`,
              "Restore the directory, or run `terrier prune`.",
            ),
          );
        }
        return Result.fail(
          repairable(
            line.fail(
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
        );
      }
      if (Result.isFailure(info) || info.success.type !== "Directory") {
        return Result.fail(
          check("Projects", "project-path", project.name).fail(
            `${collapseHome(project.path)} isn't a readable directory`,
            `Check its permissions, or unregister it (${unregisterHint(project)}).`,
          ),
        );
      }
      const repo = yield* git.locate(project.path);
      if (Option.isNone(repo)) {
        // A bare repo has no work tree to find, and no primary to compare
        // against. Its linked worktrees are checked like any others.
        const bare = yield* git
          .run(project.path, ["rev-parse", "--is-bare-repository"])
          .pipe(
            Effect.map((stdout) => stdout.trim() === "true"),
            Effect.orElseSucceed(() => false),
          );
        if (bare) return Result.succeed(project.path);
        return Result.fail(
          check("Projects", "project-repo", project.name).fail(
            `${collapseHome(project.path)} is no longer a git repository`,
            `Restore the repo, or unregister it (${unregisterHint(project)}).`,
          ),
        );
      }
      const { primaryPath, commonDir } = repo.value;
      if (primaryPath === project.path) return Result.succeed(commonDir);
      // git answers with a symlink-free path, and everything in sm
      // matches against it, so both ways this can differ are breakage.
      const detail = (yield* sameDirectory(project.path, primaryPath))
        ? `registered through a symlinked path; git calls the same directory ${collapseHome(primaryPath)}, so nothing run from inside the repo matches it`
        : `registered at ${collapseHome(project.path)}, which is a worktree of ${collapseHome(primaryPath)}, not the repo's primary checkout`;
      const readd =
        project.source === "terrier"
          ? `\`terrier add ${collapseHome(primaryPath)}\``
          : `\`${binaryName} projects add ${collapseHome(primaryPath)}\``;
      return Result.fail(
        check("Projects", "project-primary", project.name).fail(
          detail,
          `Unregister it (${unregisterHint(project)}) and re-add the resolved path (${readd}).`,
        ),
      );
    });

  // Where git last saw the linked checkout now at `dir`: its admin dir's
  // gitdir file records "<checkout>/.git".
  const recordedWorktreePath = (dir: string) =>
    Effect.gen(function* () {
      const admin = yield* git.adminDirOf(dir);
      if (Option.isNone(admin)) return "";
      const raw = yield* readText(path.join(admin.value, "gitdir"));
      const recorded = Option.getOrElse(raw, () => "").trim();
      if (recorded === "") return "";
      // worktree.useRelativePaths
      return path.dirname(
        path.isAbsolute(recorded) ? recorded : path.join(admin.value, recorded),
      );
    });

  // Folders in the managed layout git has no record of, sorted.
  const strayDirs = (
    project: RegisteredProject,
    bases: ReadonlyArray<string>,
    known: ReadonlySet<string>,
  ) =>
    Effect.gen(function* () {
      const strays: string[] = [];
      for (const base of bases) {
        const entries = yield* fs.readDirectory(base).pipe(Effect.option);
        if (Option.isNone(entries)) continue;
        for (const [name, entry] of yield* lstatIn(base, entries.value)) {
          const dir = path.join(base, name);
          if (known.has(dir) || !isDirMode(entry.mode)) continue;
          // A sibling project with the same folder name shares a managed
          // base, so only a stray whose metadata points back here counts.
          const repo = yield* git.locate(dir);
          if (Option.isSome(repo) && repo.value.primaryPath !== project.path) {
            continue;
          }
          strays.push(dir);
        }
      }
      return strays.toSorted();
    });

  // How git's worktree metadata and the disk disagree: checkouts git
  // lists whose folder is gone (a locked one is kept on purpose), ones
  // moved by hand (old path to new), and folders in the managed layout
  // git has no record of.
  const findDrift = (
    project: RegisteredProject,
    identities: ReadonlyArray<WorktreeIdentity>,
    bases: ReadonlyArray<string>,
  ) =>
    Effect.gen(function* () {
      const known = new Set(identities.map((id) => id.path));
      const missing: WorktreeIdentity[] = [];
      for (const id of identities) {
        if (!id.locked && (yield* isMissing(id.path))) missing.push(id);
      }
      const gone = new Set(missing.map((id) => id.path));
      const moved = new Map<string, string>();
      const strays: string[] = [];
      for (const stray of yield* strayDirs(project, bases, known)) {
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
      const now = Option.getOrElse(
        yield* worktrees.identities(project).pipe(Effect.option),
        () => [],
      );
      for (const [oldPath, newPath] of moved) {
        const resolved = yield* realPath(newPath);
        const found = now.find(
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
      const drift = yield* findDrift(
        project,
        yield* worktrees.identities(project),
        yield* layout.managedBases(project),
      );
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

  const checkProjectWorktrees = (
    project: ListedProject,
    identities: Result.Result<ReadonlyArray<WorktreeIdentity>, Git.GitError>,
    bases: ReadonlyArray<string>,
  ) =>
    Effect.gen(function* () {
      if (Result.isFailure(identities)) {
        return [
          check("Projects", "project-worktrees", project.name).fail(
            `git can't list this project's worktrees: ${errorText(identities.failure)}`,
            `Run \`git worktree list\` in ${collapseHome(project.path)} to see the failure.`,
          ),
        ];
      }
      const drift = yield* findDrift(project, identities.success, bases);
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
            check("Projects", "project-moved", project.name).warn(
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
            check("Projects", "project-worktrees", project.name).warn(
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
          check("Projects", "project-strays", project.name).warn(
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
      const line = check("Projects", "project-scripts", project.name);
      const entries: Entry[] = [];
      for (const slot of ["setup", "teardown"] as const) {
        for (const { token, relative } of scriptFileTokens(
          scriptOf(settings, slot),
        )) {
          if (!(yield* isMissing(path.join(project.path, relative)))) continue;
          entries.push(
            line.warn(
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
      const line = check("Projects", "project-include", project.name);
      const file = path.join(project.path, WORKTREE_INCLUDE);
      const entry = (yield* lstatIn(project.path, [WORKTREE_INCLUDE])).get(
        WORKTREE_INCLUDE,
      );
      if (entry === undefined) return [];
      if (isDirMode(entry.mode)) {
        return [
          line.warn(
            `${WORKTREE_INCLUDE} is a directory, so carry-over resolves nothing`,
            `Remove or replace ${collapseHome(file)}.`,
          ),
        ];
      }
      const readable = yield* fs
        .access(file, { readable: true })
        .pipe(Effect.result);
      if (Result.isFailure(readable)) {
        return [
          line.warn(
            `${WORKTREE_INCLUDE} can't be read (open ${file}: ${errnoText(readable.failure)}), so nothing is carried into new worktrees`,
            `Fix the permissions on ${collapseHome(file)}.`,
          ),
        ];
      }
      // The integration is opt-out: absent means on.
      if (settings?.["useWorktreeInclude"] === false) return [];
      const resolved = yield* git
        .listUntrackedMatching(project.path, file)
        .pipe(
          Effect.flatMap((candidates) =>
            candidates.length === 0
              ? Effect.void
              : git.listIgnoredPaths(project.path),
          ),
          Effect.result,
        );
      if (Result.isSuccess(resolved)) return [];
      return [
        line.warn(
          `${WORKTREE_INCLUDE} doesn't resolve: ${errorText(resolved.failure)}`,
          "Check its patterns against `git ls-files --others`.",
        ),
      ];
    });

  // A carry-over entry no checkout has fails every create after the
  // worktree already exists.
  const checkCarryOver = (
    project: ListedProject,
    settings: ConfigDoc | null,
    checkouts: ReadonlyArray<string>,
  ) =>
    Effect.gen(function* () {
      const missing: string[] = [];
      for (const entry of carryOverPaths(settings)) {
        let found = false;
        for (const checkout of checkouts) {
          if (Option.isSome(yield* statOf(path.join(checkout, entry)))) {
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
        check("Projects", "project-carryover", project.name).warn(
          `carry-over ${pluralize(n, "entry", "entries")} ${missing.join(", ")}${pluralize(n, " is", " are")} in no checkout, so new worktrees start without ${pluralize(n, "it", "them")}`,
          `Restore it in the primary checkout, or drop the entry (\`${binaryName} projects config carryover rm ${shellWord(first)} -p ${project.name}\`).`,
        ),
      ];
    });

  // Landing refs older than an hour. A ref has no timestamp, so its age
  // is the loose ref file's mtime. A packed one has been through a gc
  // and is old by definition. One in neither (reftable) is left alone.
  const staleIncomingRefs = (repo: string, commonDir: string) =>
    Effect.gen(function* () {
      const listed = yield* git
        .run(repo, ["for-each-ref", "--format=%(refname)", INCOMING_PREFIX])
        .pipe(Effect.orElseSucceed(() => ""));
      if (listed.trim() === "") return [];
      const packed = Option.getOrElse(
        yield* readText(path.join(commonDir, "packed-refs")),
        () => "",
      );
      const now = yield* Clock.currentTimeMillis;
      const stale: string[] = [];
      for (const ref of fields(listed)) {
        const info = yield* statOf(path.join(commonDir, ref));
        if (Option.isSome(info)) {
          if (now - mtimeOf(info.value) >= INCOMING_REF_STALE_MS) {
            stale.push(ref);
          }
        } else if (packed.includes(` ${ref}\n`)) {
          stale.push(ref);
        }
      }
      return stale;
    });

  // refs/shigomori/incoming/<branch> is where a transfer lands a branch
  // before making the worktree, swept straight after. One that outlives
  // its landing blocks every later branch nested under its name.
  const checkIncomingRefs = (project: ListedProject, commonDir: string) =>
    Effect.gen(function* () {
      const stale = yield* staleIncomingRefs(project.path, commonDir);
      if (stale.length === 0) return [];
      const n = stale.length;
      const shown = stale.map((ref) => ref.slice(INCOMING_PREFIX.length));
      return [
        repairable(
          check("Projects", "project-incoming", project.name).warn(
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

  // Only problems, none for a healthy project, and its checkouts.
  const checkOneProject = (project: ListedProject) =>
    Effect.gen(function* () {
      const repo = yield* checkProjectRepo(project);
      // Every check below needs a working repo.
      if (Result.isFailure(repo)) {
        return {
          entries: [repo.failure],
          identities: Option.none(),
        } satisfies ProjectChecked;
      }
      const stored = yield* config.read({
        kind: "project",
        projectId: project.id,
        path: project.path,
      });
      const { settings, defaultBranch } = projectSettingsOf(stored);
      const identities = yield* worktrees
        .identities(project)
        .pipe(Effect.result);
      const bases = yield* layout.managedBases(project);
      const entries: Entry[] = [];
      // The app and every command read a stored document with no default
      // branch as none, so its scripts and layout stop applying.
      if (stored !== null && settings === null) {
        entries.push(
          check("Projects", "project-config", project.name).warn(
            "project.json exists but is invalid (bad JSON or no defaultBranch), so its scripts and layout are ignored",
            `Run \`${binaryName} projects config --default-branch <ref> -p ${project.name}\` to rewrite it.`,
          ),
        );
      }
      const primaryRef = yield* git.resolveDefaultBranch(
        project.path,
        defaultBranch,
      );
      if (Option.isNone(primaryRef)) {
        entries.push(
          check("Projects", "project-branch", project.name).warn(
            defaultBranch !== undefined
              ? `the configured default branch ${defaultBranch.trim()} doesn't exist, and nothing else resolves either`
              : `no default branch resolves, so create has no base to fork from`,
            `Set one with \`${binaryName} projects config --default-branch <ref> -p ${project.name}\`.`,
          ),
        );
      }
      // Without a listing, carry-over still looks in the primary.
      const checkouts = Result.isSuccess(identities)
        ? identities.success.map((id) => id.path)
        : [project.path];
      entries.push(
        ...(yield* checkProjectWorktrees(project, identities, bases)),
        ...(yield* checkProjectScripts(project, settings)),
        ...(yield* checkWorktreeInclude(project, settings)),
        ...(yield* checkCarryOver(project, settings, checkouts)),
        ...(yield* launcherFindings(
          check("Projects", "project-launchers", project.name),
          settings,
          "projects config launcher rm",
          ` -p ${project.name}`,
        )),
        ...(yield* checkIncomingRefs(project, repo.success)),
      );
      return {
        entries,
        identities: Result.isSuccess(identities)
          ? Option.some(identities.success)
          : Option.none(),
      } satisfies ProjectChecked;
    });

  // One line per healthy project and one per problem otherwise, so a
  // dozen projects don't bury the findings under green ticks. A terrier
  // project gets the same checks, all but the unregister repair.
  const checkProjects = (projects: ReadonlyArray<ListedProject>) =>
    Effect.forEach(
      projects,
      (project) =>
        Effect.map(checkOneProject(project), ({ entries, identities }) => ({
          project,
          identities,
          entries:
            entries.length > 0
              ? entries
              : [
                  check("Projects", "project", project.name).ok(
                    project.source === undefined
                      ? "ok"
                      : `ok (via ${project.source})`,
                  ),
                ],
        })),
      { concurrency: "unbounded" },
    );

  // --- the run ---

  // The registry's projects, then terrier's, as every command sees them.
  // A terrier listing that failed leaves the list short, so the checks
  // that read "nothing claims this" as a leftover stand down.
  const listProjects = (listing: Terrier.TerrierListing) =>
    Effect.gen(function* () {
      const registered = yield* registry.projects;
      const extras = terrierProjects(
        new Set(registered.map(({ path: at }) => at)),
        listing.paths,
      );
      return {
        projects: [...registered, ...extras] as ReadonlyArray<ListedProject>,
        complete: Option.isNone(listing.trouble),
      };
    });

  const checkAll = (input: RunInput) =>
    Effect.gen(function* () {
      // Read once a pass, and handed to each check that asks.
      const listing = yield* terrier.listing;
      const { projects, complete } = yield* listProjects(listing);
      const device = (yield* config.read({ kind: "device" })) ?? {};
      const holder = yield* stagingHolder(stagingLock);
      const kept = yield* data.kept;
      const environment = [
        yield* checkGit,
        yield* checkGh,
        yield* checkApp(input),
        yield* checkPath,
        yield* checkShellHook(input.terminal),
      ];
      const dir = yield* checkDataDir;
      const dataDirGroup = dir.usable
        ? [
            dir.entry,
            checkGlobalConfig(device),
            yield* checkRegistry,
            yield* checkStaleLocks,
            ...checkStagingLock(holder),
            ...(yield* checkUpdateLeftovers(input.version, holder)),
            ...(yield* checkPortAllocations(device)),
            ...(yield* launcherFindings(
              check("Data dir", "launchers", "launchers"),
              device,
              "config launcher rm",
              "",
            )),
            ...checkTerrier(device, listing),
            ...(yield* checkDormantState(projects, complete, kept)),
          ]
        : [dir.entry];
      const processes = [
        ...(yield* checkOrphanTunnel),
        ...(yield* checkOrphanScripts),
      ];
      const checked = yield* checkProjects(projects);
      // Last of the data dir's lines, once the projects' checkouts are
      // listed.
      const bookkeeping = dir.usable
        ? yield* checkBookkeeping(
            projects,
            complete,
            new Map(
              checked.flatMap(({ project, identities }) =>
                Option.isSome(identities)
                  ? [[project.id, identities.value] as const]
                  : [],
              ),
            ),
            kept,
          )
        : [];
      return [
        ...environment,
        ...dataDirGroup,
        ...bookkeeping,
        ...processes,
        ...checked.flatMap(({ entries }) => entries),
      ];
    }).pipe(Effect.provideContext(platform));

  const run = Effect.fn("Doctor.run")(function* (input: RunInput) {
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
            `couldn't ${repair.label}: ${errorText(outcome.failure)}`,
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
