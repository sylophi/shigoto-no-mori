// The temp files a transfer writes, as resources of the fiber that
// made them: the scope removes the dir (or closes the handle) the
// moment it closes, however the fiber ended. A caller that leaves
// mid-transfer interrupts the fiber, so its temp bundle goes at once
// rather than at the idle sweep (host/lib/idleRegistry.ts), which is
// left to the transfers that outlive the call that started them. Those
// are handed off: a handler that registers the dir in a registry hands
// it over, and the scope then leaves it to the registry's drop.
import { type FileHandle, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, type Scope } from "effect";
import { hostAttempt } from "@host/runtime";

export type Owned<A> = {
  readonly value: A;
  // From here on the scope leaves the resource alone.
  readonly handOff: () => void;
};

function owned<A>(
  acquire: Effect.Effect<A, unknown>,
  release: (value: A) => Promise<unknown>,
): Effect.Effect<Owned<A>, unknown, Scope.Scope> {
  return Effect.suspend(() => {
    let handed = false;
    return Effect.acquireRelease(acquire, (value) =>
      handed
        ? Effect.void
        : // Best effort: rm({force}) swallows ENOENT but still throws on
          // EPERM/EBUSY, and the worst case is a temp dir the OS
          // reclaims later.
          Effect.promise(() => release(value).catch(() => {})),
    ).pipe(
      Effect.map((value) => ({
        value,
        handOff: () => {
          handed = true;
        },
      })),
    );
  });
}

// A fresh mkdtemp dir under the OS temp dir (0700, so the data is no
// more readable than the repo it came from), removed with its contents.
export const scopedTempDir = (
  prefix: string,
): Effect.Effect<Owned<string>, unknown, Scope.Scope> =>
  owned(
    hostAttempt(() => mkdtemp(join(tmpdir(), prefix))),
    (dir) => rm(dir, { recursive: true, force: true }),
  );

// An open file, closed with the scope. FileHandle.close waits for the
// handle's pending reads and writes, so a chunk abandoned mid-write is
// done before the file is closed and its dir removed.
export const scopedFile = (
  path: string,
  flags: "r" | "w",
): Effect.Effect<Owned<FileHandle>, unknown, Scope.Scope> =>
  owned(
    hostAttempt(() => open(path, flags)),
    (handle) => handle.close(),
  );
