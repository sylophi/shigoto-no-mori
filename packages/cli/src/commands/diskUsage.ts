// sm disk-usage <path> [--exclude <path>...]: the tidy page's measure of
// one folder, the nested worktrees stepped over. App plumbing, left out
// of the help as Go left it.
import { normalize } from "node:path";
import * as Hygiene from "@shigomori/engine/Hygiene";
import * as Effect from "effect/Effect";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import { UsageError } from "../errors.ts";
import { absolute, rest } from "../here.ts";
import { emit, out, Output } from "../output.ts";

export const diskUsage = Command.make(
  "disk-usage",
  { exclude: Flag.String("exclude").pipe(Flag.atLeast(0)), rest },
  (input) =>
    Effect.gen(function* () {
      const { json, binaryName } = yield* Effect.service(Output);
      const [path] = input.rest;
      if (path === undefined || input.rest.length !== 1) {
        return yield* new UsageError({
          problem: `Usage: ${binaryName} disk-usage <path> [--exclude <path>...]`,
        });
      }
      const exclude = yield* Effect.forEach(input.exclude, (each) =>
        Effect.map(absolute(each), normalize),
      );
      const usage = yield* (yield* Hygiene.Hygiene).measure(
        normalize(yield* absolute(path)),
        exclude,
      );
      if (json) return yield* emit(usage);
      const approx = usage.partial ? "~" : "";
      yield* out(
        `${approx}${usage.bytes} bytes on disk, ${approx}${usage.reclaimableBytes} reclaimable`,
      );
    }),
).pipe(Command.withDescription("A folder's size on disk"));
