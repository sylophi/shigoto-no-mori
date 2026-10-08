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
