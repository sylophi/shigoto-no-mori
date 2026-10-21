// What a failed filesystem call says about the path.
import type * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";

export const isNotFound = (error: PlatformError.PlatformError) =>
  Predicate.isTagged(error.reason, "NotFound");

// A program that isn't installed: the spawn found no binary, where a
// missing folder to run it in fails the spawn's check of its cwd.
export const isMissingProgram = (error: PlatformError.PlatformError) =>
  isNotFound(error) && error.reason.module === "ChildProcess";

// Not there: missing, or a parent on the way is a file.
export const isAbsent = (error: PlatformError.PlatformError) =>
  isNotFound(error) ||
  (Predicate.hasProperty(error.cause, "code") &&
    error.cause.code === "ENOTDIR");

// The words Go's syscall errors use for the common errnos.
const ERRNO_TEXT: Record<string, string> = {
  ENOENT: "no such file or directory",
  EACCES: "permission denied",
  EPERM: "operation not permitted",
  ENOTDIR: "not a directory",
  ENOSPC: "no space left on device",
  EROFS: "read-only file system",
  EISDIR: "is a directory",
  ELOOP: "too many levels of symbolic links",
  ENOTEMPTY: "directory not empty",
  EEXIST: "file exists",
  EXDEV: "cross-device link",
  EBUSY: "device or resource busy",
};

// An error's errno as Go words it, else `fallback`. An errno the table
// doesn't word keeps the system's own message, which names it: the
// platform's "Unknown" says nothing of it.
export const errnoWords = (cause: unknown, fallback: string) => {
  const code = Predicate.hasProperty(cause, "code") ? String(cause.code) : "";
  if (code === "") return fallback;
  return (
    ERRNO_TEXT[code] ?? (cause instanceof Error ? cause.message : fallback)
  );
};

// A failed call's errno as Go words it, else its message.
export const errnoText = (error: PlatformError.PlatformError) =>
  errnoWords(error.cause, error.message);
