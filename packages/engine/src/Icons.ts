import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Git from "./Git.ts";
import { splitZ } from "./gitParse.ts";
import {
  ICON_CANDIDATES,
  ICON_SOURCE_FILES,
  iconHref,
  joinRelative,
  mimeOf,
  packageRoots,
} from "./iconScan.ts";

// A project's icon file, and its type for a data URL.
export type IconRef = { readonly path: string; readonly mime: string };

// How long "this project has no icon" is believed before a new scan.
const MISS_TTL_MS = 24 * 60 * 60 * 1000;

export class Icons extends Context.Service<
  Icons,
  {
    // The project's icon, none when it has none. A cached answer stands
    // while the file is unchanged. `rescanMisses` looks again for a
    // project remembered as icon-less, to notice an icon added since.
    readonly of: (
      projectPath: string,
      options?: { readonly rescanMisses?: boolean },
    ) => Effect.Effect<Option.Option<IconRef>>;
    // The icon's bytes, for `sm projects icon`.
    readonly bytes: (
      projectPath: string,
      options?: { readonly rescanMisses?: boolean },
    ) => Effect.Effect<
      Option.Option<{ readonly mime: string; readonly base64: string }>
    >;
  }
>()("sm/engine/Icons") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* Git.Git;

  const isFile = (file: string) =>
    fs.stat(file).pipe(
      Effect.map((info) => info.type === "File"),
      Effect.orElseSucceed(() => false),
    );

  // Files git can see: tracked, and untracked but not ignored. None
  // when git can't say, which falls back to the folder as it is.
  const visibleFiles = (projectPath: string) =>
    git
      .run(projectPath, [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ])
      .pipe(
        Effect.map((stdout) => {
          const files = splitZ(stdout).filter((file) => file !== "");
          return files.length === 0
            ? Option.none()
            : Option.some(new Set(files));
        }),
        Effect.orElseSucceed(() => Option.none<Set<string>>()),
      );

  // Where an icon link's href lands: within git's files, or on disk
  // inside the project when git listed nothing.
  const hrefOnDisk = Effect.fn(function* (
    projectPath: string,
    root: string,
    href: string,
    files: Option.Option<ReadonlySet<string>>,
  ) {
    const clean = href.replace(/^\//, "");
    for (const relative of [
      joinRelative(root, "public", clean),
      joinRelative(root, clean),
    ]) {
      const inside = Option.match(files, {
        onNone: () => relative !== ".." && !relative.startsWith("../"),
        onSome: (listed) => listed.has(relative),
      });
      const absolute = path.join(projectPath, relative);
      if (inside && (yield* isFile(absolute))) return Option.some(absolute);
    }
    return Option.none<string>();
  });

  // The conventional files first, then an icon link in a source file,
  // within one package root. A file git lists must be on disk to win.
  const scanRoot = Effect.fn(function* (
    projectPath: string,
    root: string,
    files: Option.Option<ReadonlySet<string>>,
  ) {
    const listed = (relative: string) =>
      Option.match(files, {
        onNone: () => true,
        onSome: (set) => set.has(relative),
      });
    for (const candidate of ICON_CANDIDATES) {
      const relative = joinRelative(root, candidate);
      if (!listed(relative)) continue;
      const absolute = path.join(projectPath, relative);
      if (yield* isFile(absolute)) return Option.some(absolute);
    }
    for (const sourceFile of ICON_SOURCE_FILES) {
      const relative = joinRelative(root, sourceFile);
      if (!listed(relative)) continue;
      const source = yield* fs
        .readFileString(path.join(projectPath, relative))
        .pipe(Effect.option);
      const href = Option.flatMap(source, (text) =>
        Option.fromUndefinedOr(iconHref(text)),
      );
      if (Option.isNone(href)) continue;
      const found = yield* hrefOnDisk(projectPath, root, href.value, files);
      if (Option.isSome(found)) return found;
    }
    return Option.none<string>();
  });

  const scan = Effect.fn(function* (projectPath: string) {
    const files = yield* visibleFiles(projectPath);
    const roots = Option.match(files, {
      onNone: () => [""],
      onSome: (set) => packageRoots([...set]),
    });
    for (const root of roots) {
      const found = yield* scanRoot(projectPath, root, files);
      if (Option.isSome(found)) return found;
    }
    return Option.none<string>();
  });

  const remember = (projectPath: string, source: Option.Option<string>) =>
    Effect.gen(function* () {
      yield* sql`INSERT OR REPLACE INTO icon_cache ${sql.insert({
        project_path: projectPath,
        source_path: Option.getOrNull(source),
        updated_at: yield* Clock.currentTimeMillis,
      })}`;
    });

  const of = Effect.fn("Icons.of")(function* (
    projectPath: string,
    options?: { readonly rescanMisses?: boolean },
  ) {
    const [cached] = yield* sql<{
      source_path: string | null;
      updated_at: number;
    }>`SELECT source_path, updated_at FROM icon_cache
      WHERE project_path = ${projectPath}`;
    const now = yield* Clock.currentTimeMillis;
    // A remembered icon stands while it is still a file. A remembered
    // miss stands for a day, unless asked to look again.
    if (cached?.source_path === null) {
      if (!options?.rescanMisses && now - cached.updated_at < MISS_TTL_MS) {
        return Option.none<IconRef>();
      }
    } else if (cached !== undefined && (yield* isFile(cached.source_path))) {
      return Option.some({
        path: cached.source_path,
        mime: mimeOf(cached.source_path),
      });
    }
    const found = yield* scan(projectPath);
    yield* remember(projectPath, found);
    return Option.map(found, (source) => ({
      path: source,
      mime: mimeOf(source),
    }));
  }, Effect.orDie);

  const bytes = Effect.fn("Icons.bytes")(function* (
    projectPath: string,
    options?: { readonly rescanMisses?: boolean },
  ) {
    const icon = yield* of(projectPath, options);
    if (Option.isNone(icon)) return Option.none();
    const data = yield* fs.readFile(icon.value.path).pipe(Effect.option);
    return Option.map(data, (content) => ({
      mime: icon.value.mime,
      base64: Base64.encode(content),
    }));
  });

  return Icons.of({ of, bytes });
});

export const layer = Layer.effect(Icons, make);
