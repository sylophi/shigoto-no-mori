// The shell's files it writes on the way out: the windows to bring back
// (windows.json), a hidden or minimized app's visibility across a
// restart (restartVisibility.json), and the crash relaunches' budget
// (livenessRelaunch.json, written right before app.exit). Synchronous
// on node:fs on purpose: a write the exit could cut short is no
// write, and the crash path has no event loop to wait on. Each is
// whole or not at all, written through a temp sibling and renamed in,
// and read back schema-checked before the first window, an absent
// file reading as null. Everything the shell writes while it runs is
// on FileSystem instead (jsonFile.ts).
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  type ContractSchema,
  type Decoded,
  decode,
} from "@shigomori/contracts/codec";

const isENOENT = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

export function readJsonOrNullSync<S extends ContractSchema>(
  filePath: string,
  schema: S,
): Decoded<S> | null {
  try {
    return decode(schema, JSON.parse(readFileSync(filePath, "utf8")));
  } catch (error) {
    if (isENOENT(error)) return null;
    throw new Error(`Failed to read ${filePath}`, { cause: error });
  }
}

// A counter so two writes in one instant can't pick the same temp
// name, and the pid for a second app instance.
let tempCounter = 0;

// `mode` sets the permission bits on the created file (masked by umask
// like any create), for a file kept out of the world-readable set.
export function atomicWriteJsonSync(
  filePath: string,
  value: unknown,
  { mode }: { mode?: number } = {},
): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp.${process.pid}.${Date.now()}.${tempCounter++}`;
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
