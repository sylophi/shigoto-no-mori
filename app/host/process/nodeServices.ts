// NodeServices for the host, its recursive removes past Electron's asar
// support. Electron's fs takes an .asar for a folder, so a remove of a
// folder holding an Electron.app (a node_modules with electron in it,
// a staged update) stops partway. original-fs is Node's fs without it;
// the headless host's plain node has only that.
import * as NFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";

const { rm } = (
  (process.getBuiltinModule("original-fs") as typeof NFS | undefined) ?? NFS
).promises;

// As the Node FileSystem tells them.
const reasons: Partial<Record<string, PlatformError.SystemErrorTag>> = {
  ENOENT: "NotFound",
  EACCES: "PermissionDenied",
  EEXIST: "AlreadyExists",
  EISDIR: "BadResource",
  ENOTDIR: "BadResource",
  EBUSY: "Busy",
  ELOOP: "BadResource",
};

const removeTree = (path: string, force: boolean) =>
  Effect.tryPromise({
    try: () => rm(path, { recursive: true, force }),
    catch: (cause) => {
      const error = cause as NodeJS.ErrnoException;
      return PlatformError.systemError({
        _tag: reasons[error.code ?? ""] ?? "Unknown",
        module: "FileSystem",
        method: "remove",
        pathOrDescriptor: path,
        syscall: error.syscall,
        cause,
      });
    },
  });

const pastAsar = Layer.effect(
  FileSystem.FileSystem,
  Effect.map(
    Effect.service(FileSystem.FileSystem),
    (fs): FileSystem.FileSystem => ({
      ...fs,
      remove: (path, options) =>
        options?.recursive
          ? removeTree(path, options.force ?? false)
          : fs.remove(path, options),
    }),
  ),
);

export const layer = Layer.provideMerge(pastAsar, NodeServices.layer);
