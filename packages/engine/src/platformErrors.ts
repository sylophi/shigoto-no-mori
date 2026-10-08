// What a failed filesystem call says about the path.
import type * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";

export const isNotFound = (error: PlatformError.PlatformError) =>
  Predicate.isTagged(error.reason, "NotFound");

// Not there: missing, or a parent on the way is a file.
export const isAbsent = (error: PlatformError.PlatformError) =>
  isNotFound(error) ||
  (Predicate.hasProperty(error.cause, "code") &&
    error.cause.code === "ENOTDIR");

// The words Go's syscall errors use for the common errnos, so a message
// reads as the Go sm's did.
const ERRNO_TEXT: Record<string, string> = {
  ENOENT: "no such file or directory",
  EACCES: "permission denied",
  EPERM: "operation not permitted",
  ENOTDIR: "not a directory",
  EISDIR: "is a directory",
  ELOOP: "too many levels of symbolic links",
};

// An error's errno as Go words it, else `fallback`.
export const errnoWords = (cause: unknown, fallback: string) => {
  const code = Predicate.hasProperty(cause, "code") ? String(cause.code) : "";
  return ERRNO_TEXT[code] ?? fallback;
};

// A failed call's errno as Go words it, else its message.
export const errnoText = (error: PlatformError.PlatformError) =>
  errnoWords(error.cause, error.message);
