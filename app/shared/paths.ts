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
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { DataDirSource } from "@shigomori/engine/Paths";
import { expandHome as expandHomeIn } from "@shigomori/engine/expandHome";
import * as Paths from "@shigomori/engine/Paths";
import type { Flavor } from "@shigomori/engine/flavor";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

export type { DataDirSource };

type Found = {
  readonly dataDir: string;
  readonly source: DataDirSource;
  readonly dataDirName: string;
  readonly defaultDataDir: string;
  // The pointer file that redirected this launch, null when none did.
  readonly pointer: string | null;
  // Where a move of the data folder writes the pointer, and the pre-2.0
  // one it clears: null under initDataDirAt (the proofs), where there is
  // no pointer to write and no canonical name to rename to.
  readonly pointerFiles: {
    readonly pointer: string;
    readonly legacy: string | null;
  } | null;
};

let found: Found | null = null;

// The engine's Paths of a flavor, as this machine has them now.
export const resolvePaths = (flavor: Flavor) =>
  Effect.runPromise(
    Effect.service(Paths.Paths).pipe(
      Effect.provide(
        Paths.layer(flavor).pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );

// Called once at launch (main/index.ts, host/process/host.ts), before
// anything reads the data dir. Refuses a second call so a stray re-init
// fails loudly instead of flipping the path under live callers.
export async function initDataDir(flavor: Flavor): Promise<void> {
  if (found !== null) throw new Error("dataDir already initialized");
  const paths = await resolvePaths(flavor);
  found = {
    dataDir: paths.dataDir,
    source: paths.dataDirSource,
    dataDirName: paths.dataDirName,
    defaultDataDir: paths.defaultDataDir,
    pointer: Option.match(paths.pointer, {
      onNone: () => null,
      onSome: (pointer) => pointer.file,
    }),
    pointerFiles: {
      pointer: paths.pointerFile,
      legacy: paths.legacyPointerFile,
    },
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
    defaultDataDir: join(homedir(), ".sm"),
    pointer: null,
    pointerFiles: null,
  };
}

function current(): Found {
  if (found === null) {
    throw new Error("dataDir not initialized: call initDataDir at launch");
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
  return current().defaultDataDir;
}

// Where a move of the data folder writes the pointer, and the legacy
// one it clears. Refused when the data dir was overridden, since a
// pointer would then be ignored.
function pointerFiles(): NonNullable<Found["pointerFiles"]> {
  const { pointerFiles: files, source } = current();
  if (files === null || source === "env") {
    throw new Error(
      "The data folder can't be moved in this session: the data dir " +
        "was overridden (SHIGOMORI_DATA_DIR) or set without a flavor.",
    );
  }
  return files;
}

export function dataDirPointerPath(): string {
  return pointerFiles().pointer;
}

export function legacyDataDirPointerPath(): string | null {
  return pointerFiles().legacy;
}

export function expandHome(path: string): string {
  return expandHomeIn(homedir(), path);
}

export function toAbsolute(path: string): string {
  const expanded = expandHome(path);
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

export function isENOENT(error: unknown): boolean {
  return (
    error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
