// The data dir: where shigomori keeps its on-disk state, as the
// engine's Paths finds it (packages/engine/src/Paths.ts), the same way
// the terminal `sm` does: SHIGOMORI_DATA_DIR, then the flavor's pointer
// file, then a pre-2.0 default adopted in place, then the flavor's
// default under the home directory. Found once at launch and answered
// from memory after, since much of the host reads it synchronously.
//
// The override is something a human or a test harness sets, and it must
// stay that way: the app itself may never put SHIGOMORI_DATA_DIR into a
// child's environment. Env vars are inherited by the whole process
// tree, and the app runs the user's package.json scripts, so a `dev`
// script launched from the packaged app's script runner would boot the
// dev build, see the packaged app's data dir here, and quietly operate
// on real data.
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { DataDirSource } from "@shigomori/engine/Paths";
import * as Paths from "@shigomori/engine/Paths";
import type { Flavor } from "@shigomori/engine/flavor";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  dataDirPointerPath as pointerPathFor,
  legacyDataDirPointerPath as legacyPointerPathFor,
} from "@shared/packaging/cliDist.mts";

export type { DataDirSource };

type Found = {
  readonly dataDir: string;
  readonly source: DataDirSource;
  readonly dataDirName: string;
  // The pointer file that redirected this launch, null when none did.
  readonly pointer: string | null;
  // Null under initDataDirAt (the proofs), where there is no pointer to
  // write and no canonical name to rename to.
  readonly flavor: Flavor | null;
};

let found: Found | null = null;

// Called once at launch from main/index.ts, before anything reads the
// data dir. Refuses a second call so a stray re-init fails loudly
// instead of flipping the path under live callers.
export async function initDataDir(flavor: Flavor): Promise<void> {
  if (found !== null) throw new Error("dataDir already initialized");
  const paths = await Effect.runPromise(
    Effect.service(Paths.Paths).pipe(
      Effect.provide(
        Paths.layer(flavor).pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );
  found = {
    dataDir: paths.dataDir,
    source: paths.dataDirSource,
    dataDirName: paths.dataDirName,
    pointer: Option.match(paths.pointer, {
      onNone: () => null,
      onSome: (pointer) => pointer.file,
    }),
    flavor,
  };
}

// For the proofs, which sandbox the data dir without a flavor.
export function initDataDirAt(
  dir: string,
  source: DataDirSource = "env",
): void {
  if (found !== null) throw new Error("dataDir already initialized");
  found = {
    dataDir: dir,
    source,
    dataDirName: ".sm",
    pointer: null,
    flavor: null,
  };
}

function current(): Found {
  if (found === null) {
    throw new Error("dataDir not initialized; call initDataDir at launch");
  }
  return found;
}

export function dataDir(): string {
  return current().dataDir;
}

export function dataDirSource(): DataDirSource {
  return current().source;
}

export function dataDirPointerRead(): string | null {
  return current().pointer;
}

// The flavor's name for the data dir (.sm, .smd).
export function canonicalDataDirName(): string {
  return current().dataDirName;
}

// The flavor's default location, which needs no pointer file.
export function defaultDataDir(): string {
  return join(homedir(), canonicalDataDirName());
}

// Where a move of the data folder writes the pointer, and the legacy
// one it clears. Refused when the data dir was overridden, since a
// pointer would then be ignored.
function movableFlavor(): Flavor {
  const { flavor, source } = current();
  if (flavor === null || source === "env") {
    throw new Error(
      "The data folder can't be moved in this session: the data dir " +
        "was overridden (SHIGOMORI_DATA_DIR) or set without a flavor.",
    );
  }
  return flavor;
}

export function dataDirPointerPath(): string {
  return pointerPathFor(movableFlavor());
}

export function legacyDataDirPointerPath(): string {
  return legacyPointerPathFor(movableFlavor());
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

export function toAbsolute(path: string): string {
  const expanded = expandHome(path);
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

export function pathExists(target: string): Promise<boolean> {
  return lstat(target).then(
    () => true,
    () => false,
  );
}

export function isENOENT(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
