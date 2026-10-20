// What a clone checkout reads: config, attributes' conversions,
// lstats, the umask, a file's blob id.
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Darwin from "../Darwin.ts";
import { envVar } from "../environment.ts";
import * as Git from "../Git.ts";
import {
  blobBytes,
  type CheckoutConfig,
  CONVERSION_ATTRS,
  toHex,
} from "../gitIndex.ts";
import * as Paths from "../Paths.ts";

export const makeReads = Effect.gen(function* () {
  const git = yield* Git.Git;
  const darwin = yield* Darwin.Darwin;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const paths = yield* Paths.Paths;

  const configHome = Effect.gen(function* () {
    const xdg = yield* envVar("XDG_CONFIG_HOME");
    return xdg !== "" ? xdg : path.join(paths.home, ".config");
  });

  // The process's umask, read the only way that doesn't set it: a file
  // made with every permission keeps those the umask leaves.
  const umask = yield* Effect.cached(
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* fs.makeTempDirectoryScoped();
        const probe = path.join(dir, "probe");
        yield* fs.writeFile(probe, new Uint8Array(), {
          mode: 0o777,
          flag: "wx",
        });
        return 0o777 & ~(yield* fs.stat(probe)).mode;
      }),
    ).pipe(Effect.orElseSucceed(() => 0o022)),
  );

  const lstatUnder = (root: string, relative: ReadonlyArray<string>) =>
    Darwin.lstatByPath(darwin, root, relative);

  // lstat of absolute paths, by path. Best effort: a path it can't answer
  // for reads as absent.
  const lstatAll = (files: ReadonlyArray<string>) =>
    lstatUnder(
      "/",
      files.map((file) => file.slice(1)),
    ).pipe(
      Effect.map(
        (found) =>
          new Map([...found].map(([rel, entry]) => [`/${rel}`, entry])),
      ),
      Effect.orElseSucceed(() => new Map<string, Darwin.LstatEntry>()),
    );

  const configValue = (checkout: string, args: ReadonlyArray<string>) =>
    git.run(checkout, ["config", ...args]).pipe(
      Effect.map((out) => Option.some(out.trim().toLowerCase())),
      // Unset reads as an exit code 1 with no output.
      Effect.orElseSucceed(() => Option.none<string>()),
    );

  // A boolean setting git reads as true.
  const configBool = (checkout: string, key: string) =>
    configValue(checkout, ["--bool", key]).pipe(
      Effect.map((value) => Option.contains(value, "true")),
    );

  const readCheckoutConfig = Effect.fnUntraced(function* (checkout: string) {
    const eol = Option.getOrElse(
      yield* configValue(checkout, ["--get", "core.eol"]),
      () => "",
    );
    // git reads booleans its own way, so it's asked to. autocrlf also
    // takes "input", which isn't one. A value git can't read at all is
    // taken as true, which only leaves more to git.
    let autocrlf = "false";
    const raw = yield* configValue(checkout, ["--get", "core.autocrlf"]);
    if (Option.isSome(raw) && raw.value === "input") autocrlf = "input";
    else if (Option.isSome(raw)) {
      const value = yield* configValue(checkout, [
        "--type=bool",
        "--get",
        "core.autocrlf",
      ]);
      if (Option.isNone(value) || value.value === "true") autocrlf = "true";
    }
    let symlinks = true;
    if (
      Option.isSome(yield* configValue(checkout, ["--get", "core.symlinks"]))
    ) {
      const value = yield* configValue(checkout, [
        "--type=bool",
        "--get",
        "core.symlinks",
      ]);
      symlinks = Option.isSome(value) && value.value === "true";
    }
    return { autocrlf, eol, symlinks } satisfies CheckoutConfig;
  });

  // What decides each path's conversions: the attributes as a checkout
  // of HEAD sees them and as the source saw them when it wrote and last
  // hashed its files, and both sides' config.
  const readConversions = (
    source: string,
    worktree: string,
    targetPaths: string,
  ) =>
    Effect.all(
      {
        attr: git.run(
          worktree,
          [
            "check-attr",
            "--source",
            "HEAD",
            "-z",
            "--stdin",
            ...CONVERSION_ATTRS,
          ],
          { stdin: targetPaths },
        ),
        sourceAttr: git.run(
          source,
          ["check-attr", "-z", "--stdin", ...CONVERSION_ATTRS],
          { stdin: targetPaths },
        ),
        config: readCheckoutConfig(worktree),
        sourceConfig: readCheckoutConfig(source),
      },
      { concurrency: "unbounded" },
    );

  // The object id git gives the file at `file` as a blob of this mode,
  // its bytes taken as they are: a symlink's target, a file's content.
  const blobId = Effect.fnUntraced(function* (file: string, mode: number) {
    const content =
      mode === 0o120000
        ? new TextEncoder().encode(yield* fs.readLink(file))
        : yield* fs.readFile(file);
    return toHex(yield* crypto.digest("SHA-1", blobBytes(content)));
  });

  return {
    configHome,
    umask,
    lstatUnder,
    lstatAll,
    configValue,
    configBool,
    readConversions,
    blobId,
  };
});

export type ReadsArea = Effect.Success<typeof makeReads>;
