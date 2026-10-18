// What a host that exited unasked leaves of its loopback in the data
// dir (host/socket/Loopback.ts): loopback.json while it still names
// that host, which would send a terminal to a dead port until the next
// host publishes, and the `loopback.json.<pid>` it was writing aside, if
// it died before renaming it in. Cleared by the shell as it forks the
// next host (main/hostProcess.ts). Asynchronous, so a data dir whose
// volume is stuck holds this and not the shell.
import {
  LOOPBACK_FILE,
  LoopbackFile,
  loopbackPartialOf,
} from "@shigomori/engine/Control";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

export async function clearLoopbackOf(
  dataDir: string,
  pid: number,
): Promise<void> {
  const file = join(dataDir, LOOPBACK_FILE);
  await rm(loopbackPartialOf(file, pid), { force: true }).catch(() => {});
  const held = await readFile(file, "utf8").catch(() => null);
  if (held === null) return;
  const named = Schema.decodeUnknownOption(LoopbackFile)(held);
  if (Option.isSome(named) && named.value.pid === pid) {
    await rm(file, { force: true }).catch(() => {});
  }
}
