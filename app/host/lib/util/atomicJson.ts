// The app's own JSON files (the running scripts, the mirror files, the
// windows and the updater bridge, userData's client config):
// whole-file writes through a temp sibling, so a reader never sees one
// half written, and schema-checked reads. The projects, worktrees and
// settings are the store's (host/lib/engine.ts).
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  type ContractSchema,
  type Decoded,
  decode,
} from "@shigomori/contracts/codec";

const isENOENT = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

// Best-effort delete: a file that is already gone is fine.
export async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (err) {
    if (!isENOENT(err)) throw err;
  }
}

// The shared tail of the async and sync readers: JSON-parse, validate,
// absent reads as null, and anything else is wrapped with the path
// attached.
function finishJsonRead<S extends ContractSchema>(
  filePath: string,
  schema: S,
  read: () => string,
): Decoded<S> | null {
  try {
    return decode(schema, JSON.parse(read()));
  } catch (error) {
    if (isENOENT(error)) return null;
    throw new Error(`Failed to read ${filePath}`, { cause: error });
  }
}

export async function readJsonOrNull<S extends ContractSchema>(
  filePath: string,
  schema: S,
): Promise<Decoded<S> | null> {
  let read: () => string;
  try {
    const raw = await readFile(filePath, "utf8");
    read = () => raw;
  } catch (error) {
    read = () => {
      throw error;
    };
  }
  return finishJsonRead(filePath, schema, read);
}

// For readers that can't await (the boot path needs the client config
// before the BrowserWindow exists).
export function readJsonOrNullSync<S extends ContractSchema>(
  filePath: string,
  schema: S,
): Decoded<S> | null {
  return finishJsonRead(filePath, schema, () => readFileSync(filePath, "utf8"));
}

// A counter so two parallel writers can't pick the same temp name, and
// the pid for a second app instance.
let tempCounter = 0;

export function tempPathFor(filePath: string): string {
  return `${filePath}.tmp.${process.pid}.${Date.now()}.${tempCounter++}`;
}

// `mode` sets the permission bits on the created file (masked by umask
// like any create), for a file kept out of the data dir's
// world-readable set, e.g. a file holding a token.
export function atomicWriteJsonSync(
  filePath: string,
  value: unknown,
  { mode }: { mode?: number } = {},
): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const temp = tempPathFor(filePath);
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode,
  });
  try {
    renameSync(temp, filePath);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // Best effort; the stray temp file is harmless.
    }
    throw error;
  }
}

export async function atomicWriteJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temp = tempPathFor(filePath);
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await rename(temp, filePath);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}
