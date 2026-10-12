// The store's failures in words: a statement SQLite refused, sorted by
// what a person can do about it. The services read the store as a given
// (a failure there is a defect), so what reached the terminal and the
// app was the driver's "Failed to execute statement"; the transports
// read it back here (errorDocument.ts, the host's call failures), and
// the store's open says it too.
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

const CATEGORIES = ["busy", "full", "read-only", "damaged", "failed"] as const;
type Category = (typeof CATEGORIES)[number];

export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  category: Schema.Literals(CATEGORIES),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return storeWords[this.category];
  }

  get documentCode(): string {
    return `store-${this.category}`;
  }
}

export const storeWords: Record<Category, string> = {
  busy: "The store is busy: the app or another command is writing to it. Try again in a moment.",
  full: "The store couldn't be written: the disk is full.",
  "read-only":
    "The store is read-only here. Check the data folder's permissions (the doctor says which).",
  damaged: "The store looks damaged. The doctor says what it can repair.",
  failed: "Couldn't read or write the store.",
};

// Everything the driver said about it, its code among it.
const textOf = (error: unknown): string => {
  const parts: string[] = [];
  let at: unknown = error;
  for (let depth = 0; at !== undefined && at !== null && depth < 4; depth++) {
    if (Predicate.hasProperty(at, "message")) parts.push(String(at.message));
    if (Predicate.hasProperty(at, "code")) parts.push(String(at.code));
    if (Predicate.hasProperty(at, "errstr")) parts.push(String(at.errstr));
    at = Predicate.hasProperty(at, "reason")
      ? at.reason
      : Predicate.hasProperty(at, "cause")
        ? at.cause
        : undefined;
  }
  return parts.join(" ");
};

export const categoryOf = (error: unknown): Category => {
  if (
    Predicate.hasProperty(error, "reason") &&
    Predicate.isTagged(error.reason, "LockTimeoutError")
  ) {
    return "busy";
  }
  const said = textOf(error);
  if (/SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(said)) return "busy";
  if (/SQLITE_FULL|disk is full|ENOSPC/i.test(said)) return "full";
  if (/SQLITE_READONLY|readonly database|read-only/i.test(said)) {
    return "read-only";
  }
  if (/SQLITE_CORRUPT|SQLITE_NOTADB|malformed|not a database/i.test(said)) {
    return "damaged";
  }
  return "failed";
};

// A failure the store's SQL raised, in words; none for anything else.
export const storeErrorOf = (error: unknown): StoreError | undefined =>
  Predicate.isTagged(error, "SqlError")
    ? new StoreError({ category: categoryOf(error), cause: error })
    : undefined;
