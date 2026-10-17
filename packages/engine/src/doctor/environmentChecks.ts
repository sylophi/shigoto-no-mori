// The doctor's environment checks: git, gh, the shell hook and its wrapper, the programs `sm` runs.
import { tildify } from "@shigomori/contracts/projectPaths";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { belowGitFloor, fields, parseGitVersion } from "../doctorParse.ts";
import { envVar } from "../environment.ts";
import { findExecutable } from "../executables.ts";
import { flavorNames } from "../flavor.ts";
import * as Git from "../Git.ts";
import { appFoldersOf } from "../Launchers.ts";
import * as Paths from "../Paths.ts";
import {
  CD_FILE_ENV,
  hookPlace,
  inspectHook,
  SHELL_KINDS,
  type ShellKind,
} from "../shellHook.ts";
import { type RunInput, check } from "./documents.ts";
import type { ReadsArea } from "./reads.ts";
import { bundleVersionArgs, isAsideName } from "../updater/documents.ts";

export const makeEnvironmentChecks = ({
  reads,
}: {
  readonly reads: ReadsArea;
}) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const paths = yield* Paths.Paths;
    const git = yield* Git.Git;
    const { home, binaryName, flavor } = paths;
    const names = flavorNames(flavor);
    // ZDOTDIR read once, as Paths reads the environment.
    const place = hookPlace(paths, yield* envVar("ZDOTDIR"));
    // The shell wrapper's directive file, set while the hook is active.
    const cdFile = yield* envVar(CD_FILE_ENV);

    const { capture, statOf, realPath, listDir } = reads;
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
        const candidate = path.join(root, `${names.appName}.app`);
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
          .filter((name) => isAsideName(`${names.appName}.app`, name))
          .toSorted();
        if (aside !== undefined) return Option.some(path.join(root, aside));
      }
      return Option.none<string>();
    });

    // Empty when it can't be read.
    const bundleVersion = (bundle: string) =>
      capture(
        "plutil",
        bundleVersionArgs(path.join(bundle, "Contents", "Info.plist")),
      ).pipe(
        Effect.map(({ stdout, code }) => (code === 0 ? stdout.trim() : "")),
        Effect.orElseSucceed(() => ""),
      );

    // The binary's own identity, and whether the app bundle behind it
    // agrees: a version mismatch means the sm on PATH is a stray copy
    // that `sm update` won't carry along.
    const checkApp = ({ version, executable }: RunInput) =>
      Effect.gen(function* () {
        const line = check("Environment", "app", "app");
        if (flavor === "dev") {
          return line.ok(
            `dev build (${binaryName} ${version}): runs from a checkout, no installed bundle`,
          );
        }
        const bundle = yield* installedBundle(executable);
        if (Option.isNone(bundle)) {
          const found = yield* findInstalledBundle;
          if (Option.isSome(found)) {
            return line.warn(
              `this binary isn't the one inside ${tildify(found.value, home)}, so \`${binaryName} update\` can't reach it`,
              `Re-link the CLI from the app's Settings, or run ${tildify(path.join(found.value, "Contents", "Resources", binaryName), home)}.`,
            );
          }
          const aside = yield* findAsideBundle;
          if (Option.isSome(aside)) {
            return line.fail(
              `the app is missing, but ${tildify(aside.value, home)} is the copy an interrupted update set aside`,
              `Rename it back to ${names.appName}.app.`,
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
            `${tildify(bundle.value, home)} has no readable version in Info.plist`,
            "Reinstall the app.",
          );
        }
        if (appVersion !== version) {
          return line.warn(
            `app is ${appVersion} but this CLI is ${version}. They ship together, so one of them is stale`,
            `Run \`${binaryName} update\`, or re-link the CLI from the app's Settings.`,
          );
        }
        return line.ok(`${appVersion} at ${tildify(bundle.value, home)}`);
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
        found.push(tildify(candidate, home));
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
          const hook = yield* inspectHook(place, kind);
          if (hook.state === "installed") {
            installed.push(kind);
            if (!hook.current) stale.push(kind);
          } else if (hook.state === "modified" || hook.state === "unreadable") {
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

    return { checkGit, checkGh, checkApp, checkPath, checkShellHook };
  });

export type EnvironmentChecksArea = Effect.Success<
  ReturnType<typeof makeEnvironmentChecks>
>;
