// The platform's Path and FileSystem as every runtime takes them (the
// app's processes, the terminal `sm`, the tests): on Windows, each path
// they answer is canonical (canonicalPath.ts), since Node's and Bun's
// answer with backslashes. On macOS and Linux they are the platform's
// own.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { canonicalPath } from "./canonicalPath.ts";
import { byPlatform } from "./platform.ts";

const canonicalPaths = (paths: ReadonlyArray<string>) =>
  paths.map(canonicalPath);

const windowsPath = (path: Path.Path): Path.Path => ({
  ...path,
  sep: "/",
  dirname: (p) => canonicalPath(path.dirname(p)),
  format: (parsed) => canonicalPath(path.format(parsed)),
  fromFileUrl: (url) => Effect.map(path.fromFileUrl(url), canonicalPath),
  join: (...paths) => canonicalPath(path.join(...paths)),
  normalize: (p) => canonicalPath(path.normalize(p)),
  parse: (p) => {
    const parsed = path.parse(p);
    return {
      ...parsed,
      root: canonicalPath(parsed.root),
      dir: canonicalPath(parsed.dir),
    };
  },
  relative: (from, to) => canonicalPath(path.relative(from, to)),
  resolve: (...paths) => canonicalPath(path.resolve(...paths)),
});

const windowsFileSystem = (
  fs: FileSystem.FileSystem,
): FileSystem.FileSystem => ({
  ...fs,
  glob: (pattern, options) =>
    Effect.map(fs.glob(pattern, options), canonicalPaths),
  makeTempDirectory: (options) =>
    Effect.map(fs.makeTempDirectory(options), canonicalPath),
  makeTempDirectoryScoped: (options) =>
    Effect.map(fs.makeTempDirectoryScoped(options), canonicalPath),
  makeTempFile: (options) =>
    Effect.map(fs.makeTempFile(options), canonicalPath),
  makeTempFileScoped: (options) =>
    Effect.map(fs.makeTempFileScoped(options), canonicalPath),
  readDirectory: (path, options) =>
    Effect.map(fs.readDirectory(path, options), canonicalPaths),
  readLink: (path) => Effect.map(fs.readLink(path), canonicalPath),
  realPath: (path) => Effect.map(fs.realPath(path), canonicalPath),
  watch: (path, options) =>
    Stream.map(fs.watch(path, options), (event) => ({
      ...event,
      path: canonicalPath(event.path),
    })),
});

const windows = Layer.merge(
  Layer.effect(Path.Path, Effect.map(Path.Path, windowsPath)),
  Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, windowsFileSystem),
  ),
);

// `platform` (NodeServices, BunServices) with its Path and FileSystem
// made canonical.
export const canonicalPlatform = <A, E, R>(
  platform: Layer.Layer<A | Path.Path | FileSystem.FileSystem, E, R>,
): Layer.Layer<A | Path.Path | FileSystem.FileSystem, E, R> =>
  Layer.suspend(() => {
    const win32 = Layer.provideMerge(windows, platform);
    return byPlatform({ darwin: platform, linux: platform, win32 });
  });
