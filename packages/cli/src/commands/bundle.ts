// sm bundle create --out <path> --ref <fullRef>... [--have <sha>...] |
// sm bundle unpack [--repo <path>] --in <path> --refspec <src>:<dst>...:
// the git bundles a transfer carries commits in.
import * as Bundle from "@shigomori/engine/Bundle";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import { UsageError } from "../errors.ts";
import { absolute, given, projectFlags, resolveProject } from "../here.ts";
import { emit, note, out, Output, styles } from "../output.ts";

const many = (name: string) => Flag.String(name).pipe(Flag.atLeast(0));
const one = (name: string) => Flag.String(name).pipe(Flag.optional);

export const bundle = Command.make(
  "bundle",
  {
    ...projectFlags,
    args: Argument.String("args").pipe(Argument.variadic()),
    repo: one("repo"),
    out: one("out"),
    in: one("in"),
    ref: many("ref"),
    have: many("have"),
    refspec: many("refspec"),
  },
  (input) =>
    Effect.gen(function* () {
      const { json, binaryName, stdoutColor } = yield* Effect.service(Output);
      const verb = input.args[0];
      if (verb !== "create" && verb !== "unpack") {
        return yield* new UsageError({
          problem: `Usage: ${binaryName} bundle create --out <path> --ref <fullRef>... [--have <sha>...] | ${binaryName} bundle unpack [--repo <path>] --in <path> --refspec <src>:<dst>...`,
        });
      }
      // The repository itself, for an unpack into one no project names.
      const repo = given(input.repo);
      let path: string;
      if (Option.isSome(repo)) {
        if (verb !== "unpack" || repo.value.startsWith("-")) {
          return yield* new UsageError({
            problem: "--repo <path> is for unpack.",
          });
        }
        if (
          Option.isSome(given(input.project)) ||
          Option.isSome(given(input.projectId))
        ) {
          return yield* new UsageError({
            problem:
              "--repo names the repository itself; leave --project and --project-id off.",
          });
        }
        path = yield* absolute(repo.value);
      } else {
        path = (yield* resolveProject(input)).path;
      }
      const service = yield* Bundle.Bundle;
      const { green } = styles(stdoutColor);
      if (verb === "create") {
        const outPath = Option.getOrElse(given(input.out), () => "");
        if (
          outPath === "" ||
          outPath.startsWith("-") ||
          input.ref.length === 0
        ) {
          return yield* new UsageError({
            problem: `Usage: ${binaryName} bundle create --out <path> --ref <fullRef>... [--have <sha>...]`,
          });
        }
        const made = yield* service.create(
          path,
          outPath,
          input.ref,
          input.have,
        );
        for (const have of made.skippedHaves ?? []) {
          yield* note(`skipping unknown have ${have}`);
        }
        return yield* json
          ? emit({ ok: true, ...made })
          : out(
              green(
                `bundled ${made.refs.length} ref(s) (${made.bytes} bytes) to ${made.path}`,
              ),
            );
      }
      const from = Option.getOrElse(given(input.in), () => "");
      if (from === "" || from.startsWith("-") || input.refspec.length === 0) {
        return yield* new UsageError({
          problem: `Usage: ${binaryName} bundle unpack --in <path> --refspec <src>:<dst>...`,
        });
      }
      const fetched = yield* service.unpack(path, from, input.refspec);
      yield* json
        ? emit({ ok: true, fetched })
        : out(green(`fetched ${fetched.length} ref(s) from ${from}`));
    }),
).pipe(Command.withDescription("Make or unpack a git bundle (app plumbing)"));
