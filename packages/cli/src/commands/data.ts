// sm data [move <folder> | reset]: where the data folder lives, and the
// move Settings' Data location makes, which restarts the host holding
// it (host/ipc/modules/runtime.ts).
import { join, resolve } from "node:path";
import type { RuntimeInfo } from "@shigomori/contracts/schemas";
import { byPlatform } from "@shigomori/engine/platform";
import * as Effect from "effect/Effect";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import { askHost } from "../askHost.ts";
import { rest } from "../here.ts";
import { emit, out, Output, styles } from "../output.ts";

const RESTARTS = byPlatform({
  darwin: "The app restarts into it.",
  linux: "The host restarts into it.",
});

const info = askHost<RuntimeInfo>("runtime:info");

const moveTo = (parentDir: string | undefined) =>
  Effect.gen(function* () {
    const { json, stdoutColor } = yield* Effect.service(Output);
    const { canonicalDataDirName } = yield* info;
    yield* askHost<void>("runtime:moveDataDir", { parentDir });
    const dataDir =
      parentDir === undefined ? null : join(parentDir, canonicalDataDirName);
    if (json) return yield* emit({ ok: true, dataDir });
    const moved =
      dataDir === null
        ? "Moved the data folder back to its default place."
        : `Moved the data folder to ${dataDir}.`;
    yield* out(`${styles(stdoutColor).green(moved)} ${RESTARTS}`);
  });

const move = Command.make(
  "move",
  { folder: Argument.String("folder") },
  ({ folder }) => moveTo(resolve(folder)),
);

const reset = Command.make("reset", { rest }, () => moveTo(undefined));

export const dataCommand = Command.make("data", {}, () =>
  Effect.gen(function* () {
    const { json, stdoutColor } = yield* Effect.service(Output);
    const runtime = yield* info;
    if (json) {
      const { dataDir, dataDirSource, atDefaultDataDir } = runtime;
      return yield* emit({
        ok: true,
        dataDir,
        dataDirSource,
        atDefaultDataDir,
      });
    }
    yield* out(runtime.dataDir);
    if (runtime.dataDirSource === "env") {
      yield* out(
        styles(stdoutColor).dim("Set by SHIGOMORI_DATA_DIR, so it stays put."),
      );
    }
  }),
).pipe(Command.withSubcommands([move, reset]));
