// The cross-device verbs over the engine's Transfer, which the running
// app carries out: send and bring move a worktree, mirror keeps a copy
// in step, unmirror stops one, projects clone sets a project up on a
// device that lacks it, mirrors and devices list. The remote
// listing (`list --remote`, `--from`) is here too.
import type { ControlDevice } from "@shigomori/contracts/modules/control";
import * as Transfer from "@shigomori/engine/Transfer";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import { ExitCode, UsageError } from "../errors.ts";
import { accessSwitches } from "./access.ts";
import { deviceCommands } from "./login.ts";
import { given, here, projectFlags, rest, worktreeFlags } from "../here.ts";
import { emit, note, out, Output, renderTable, styles } from "../output.ts";

// A flag: absent, or given (blank included).
const raw = (flag: Option.Option<string>) => Option.getOrUndefined(flag);

const target = (input: {
  readonly ref: Option.Option<string>;
  readonly project: Option.Option<string>;
  readonly projectId: Option.Option<string>;
  readonly worktreeId: Option.Option<string>;
}) => ({
  ref: Option.getOrUndefined(given(input.ref)),
  project: Option.getOrUndefined(given(input.project)),
  projectId: Option.getOrUndefined(given(input.projectId)),
  worktreeId: Option.getOrUndefined(given(input.worktreeId)),
});

const transferFlags = {
  ...worktreeFlags,
  ref: Argument.String("worktree").pipe(Argument.optional),
  // The first positional is read and the rest let be.
  rest,
  to: Flag.String("to").pipe(Flag.optional),
  from: Flag.String("from").pipe(Flag.optional),
  leaveOut: Flag.String("leave-out").pipe(Flag.optional),
  source: Flag.String("source").pipe(Flag.optional),
  cloneInto: Flag.String("clone-into").pipe(Flag.optional),
  setup: Flag.Boolean("setup").pipe(Flag.withDefault(false)),
  noSetup: Flag.Boolean("no-setup").pipe(Flag.withDefault(false)),
};

type TransferInput = Command.Command.Config.Infer<typeof transferFlags>;

// Each step once on stderr, or every frame as an event under --json.
const onProgress = Effect.map(
  Effect.service(Output),
  ({ json, stderrColor }): Transfer.OnProgress =>
    ({ document, line }) =>
      json
        ? emit(document)
        : line === undefined
          ? Effect.void
          : note(styles(stderrColor).dim(`  ${line}`)),
);

// A finished transfer or clone: the story on stderr and the copy's path
// alone on stdout, as create's, so `cd "$(sm bring <name>)"` works. A
// copy on another device (`elsewhere`) has no path here, so it is part
// of the story. It exits 3 with a caveat, which a script mustn't read
// as a clean run.
const report = (finished: {
  readonly document: { readonly caveats: readonly string[] };
  readonly headline: string;
  readonly along: readonly (string | false)[];
  readonly path: string;
  readonly elsewhere: string | undefined;
}) =>
  Effect.gen(function* () {
    const { document } = finished;
    const { json, stderrColor } = yield* Effect.service(Output);
    const { dim, green, yellow } = styles(stderrColor);
    const code = document.caveats.length > 0 ? 3 : 0;
    if (json) {
      yield* emit(document);
    } else {
      yield* note(green(finished.headline));
      for (const line of finished.along) {
        if (line !== false) yield* note(dim(`  ${line}`));
      }
      for (const caveat of document.caveats) {
        yield* note(yellow(`! ${caveat}`));
      }
      if (finished.elsewhere === undefined) {
        yield* out(finished.path);
      } else {
        yield* note(dim(`  at ${finished.path} on "${finished.elsewhere}"`));
      }
    }
    if (code !== 0) return yield* new ExitCode({ code });
  });

const transferVerb = (name: "send" | "bring" | "mirror") =>
  Command.make(name, transferFlags, (input: TransferInput) =>
    Effect.gen(function* () {
      const transfer = yield* Transfer.Transfer;
      const at = yield* here;
      const flags: Transfer.TransferFlags = {
        to: raw(input.to),
        from: raw(input.from),
        leaveOut: raw(input.leaveOut),
        source: raw(input.source),
        cloneInto: raw(input.cloneInto),
        setup: input.setup,
        noSetup: input.noSetup,
      };
      const { document, headline, result } = yield* transfer[name](
        at,
        target(input),
        flags,
        yield* onProgress,
      );
      const { source } = result;
      yield* report({
        document,
        headline,
        along: [
          result.captured &&
            result.dirtyApplied &&
            "uncommitted changes went along",
          result.files?.crossed === true && "ignored files went along",
          source !== undefined &&
            source.done &&
            source.fate !== "keep" &&
            `source ${Transfer.sourceFateDone(source.fate)}`,
        ],
        path: result.worktree.path,
        elsewhere: result.copySide === "local" ? undefined : result.device.name,
      });
    }),
  );

export const send = transferVerb("send");
export const bring = transferVerb("bring");
export const mirror = transferVerb("mirror");

export const cloneProject = Command.make(
  "clone",
  {
    project: Argument.String("project"),
    rest,
    from: Flag.String("from").pipe(Flag.optional),
    to: Flag.String("to").pipe(Flag.optional),
    into: Flag.String("into").pipe(Flag.optional),
  },
  (input) =>
    Effect.gen(function* () {
      const { document, headline, result } =
        yield* (yield* Transfer.Transfer).cloneProject(
          yield* here,
          {
            project: input.project,
            from: raw(input.from),
            to: raw(input.to),
            into: raw(input.into),
          },
          yield* onProgress,
        );
      yield* report({
        document,
        headline,
        along: [
          result.settings.copied && "its settings came along",
          result.files?.crossed === true && "its carry-over files came along",
        ],
        path: result.project.path,
        elsewhere: raw(input.to) === undefined ? undefined : result.device.name,
      });
    }),
);

export const unmirror = Command.make(
  "unmirror",
  {
    ...worktreeFlags,
    ref: Argument.String("worktree").pipe(Argument.optional),
    rest,
    force: Flag.Boolean("force").pipe(
      Flag.withAlias("f"),
      Flag.withDefault(false),
    ),
  },
  (input) =>
    Effect.gen(function* () {
      const stopped = yield* (yield* Transfer.Transfer).unmirror(
        yield* here,
        target(input),
        { force: input.force },
      );
      const { document, worktree } = stopped;
      const { json, stdoutColor, stderrColor } = yield* Effect.service(Output);
      const code = document.caveats.length > 0 ? 3 : 0;
      if (json) {
        yield* emit(document);
      } else {
        const { dim, green } = styles(stdoutColor);
        yield* out(green(`stopped mirroring ${worktree.name}`));
        if (code !== 0) {
          yield* note(
            styles(stderrColor).yellow(`! ${document.caveats[0] ?? ""}`),
          );
        } else {
          const { mirror: stoppedMirror } = document;
          yield* out(
            dim(
              stoppedMirror.copySide === "local"
                ? `  removed the copy here: ${stoppedMirror.localRoot}`
                : `  removed the copy on "${stoppedMirror.device.name}"`,
            ),
          );
        }
      }
      if (code !== 0) return yield* new ExitCode({ code });
    }),
);

export const mirrors = Command.make("mirrors", { rest }, (input) =>
  Effect.gen(function* () {
    if (input.rest.length > 0) {
      return yield* new UsageError({
        problem: "mirrors takes no arguments.",
      });
    }
    const listed = yield* (yield* Transfer.Transfer).mirrors;
    const { json, stdoutColor, stderrColor } = yield* Effect.service(Output);
    if (json) return yield* emit(listed);
    if (listed.daemon !== "running") {
      yield* note(
        styles(stderrColor).yellow(
          `! the mirror engine is ${listed.daemon}${listed.daemonFailure === "" ? "" : `: it ${listed.daemonFailure}`}`,
        ),
      );
    }
    const { dim } = styles(stdoutColor);
    if (listed.mirrors.length === 0) {
      return yield* out(dim("No mirrors running on this device."));
    }
    yield* out(
      renderTable(
        ["WORKTREE", "DEVICE", "COPY", "FILES", "GIT"],
        listed.mirrors.map((one) => [
          one.localRoot,
          one.device.name,
          one.copySide === "local" ? "copy here" : "copy there",
          `${one.paused ? "paused" : one.status}${one.conflicts > 0 ? ` (${one.conflicts} conflicts)` : ""}`,
          one.git === undefined || one.git === "" ? "-" : one.git,
        ]),
        stdoutColor,
      ),
    );
  }),
);

// What a device's block says in the devices table, beside the host's
// words for the verb it refuses (host/lib/control/plan.ts BLOCK_REASON):
// one per reason the contract names.
const BLOCKS: Readonly<Record<NonNullable<ControlDevice["block"]>, string>> = {
  offline: "not connected",
  "not-sharing": "doesn't share with other devices",
  "no-project": "no checkout yet; a send clones the repo there",
  "no-grant": "doesn't accept commands",
  refused: "turned the ask away",
};

export const devices = Command.make("devices", {}, (input) =>
  Effect.gen(function* () {
    // The shared flags reach the parent's handler too, untyped there.
    const flags = input as typeof input & {
      readonly project: Option.Option<string>;
      readonly projectId: Option.Option<string>;
    };
    const at = yield* here;
    const ref = {
      project: Option.getOrUndefined(given(flags.project)),
      projectId: Option.getOrUndefined(given(flags.projectId)),
    };
    const listed = yield* (yield* Transfer.Transfer).devices(at, ref);
    const { json, stdoutColor } = yield* Effect.service(Output);
    if (json) return yield* emit(listed);
    const { dim, green, yellow } = styles(stdoutColor);
    yield* out(dim(`This device is "${listed.thisDevice.name}".`));
    if (listed.devices.length === 0) {
      return yield* out(dim("The account has no other device."));
    }
    const scoped =
      ref.project !== undefined ||
      ref.projectId !== undefined ||
      at.current !== undefined;
    yield* out(
      renderTable(
        ["DEVICE", "PLATFORM", "STATUS"],
        listed.devices.map((device) => {
          // A reason from a newer app than this build shows as it came.
          const block: string = device.block ?? "";
          return [
            device.name,
            device.platform,
            block === ""
              ? green(scoped ? "ready" : "connected")
              : yellow(
                  `${BLOCKS[block as keyof typeof BLOCKS] ?? block}${device.refusal === undefined ? "" : ` (${device.refusal})`}`,
                ),
          ];
        }),
        stdoutColor,
      ),
    );
  }),
).pipe(
  Command.withSharedFlags(projectFlags),
  Command.withSubcommands([...accessSwitches, ...deviceCommands]),
);

// list --remote [--from <device>]: the project's worktrees on the other
// devices, the names bring and mirror --from take.
export const listRemote = (input: {
  readonly project: Option.Option<string>;
  readonly projectId: Option.Option<string>;
  readonly from: Option.Option<string>;
}) =>
  Effect.gen(function* () {
    const listed = yield* (yield* Transfer.Transfer).peerWorktrees(
      yield* here,
      {
        project: Option.getOrUndefined(given(input.project)),
        projectId: Option.getOrUndefined(given(input.projectId)),
        from: raw(input.from),
      },
    );
    const { json, stdoutColor, stderrColor } = yield* Effect.service(Output);
    // In both modes: an empty list mustn't read as nothing there when a
    // device simply wasn't asked.
    for (const name of listed.unreachable) {
      yield* note(
        styles(stderrColor).yellow(
          `! "${name}" is not connected, so its worktrees are not listed`,
        ),
      );
    }
    if (json) return yield* emit(listed.document);
    if (listed.document.length === 0) {
      return yield* out(
        styles(stdoutColor).dim(
          `No worktrees of ${listed.project.name} on another connected device.`,
        ),
      );
    }
    yield* out(
      renderTable(
        ["WORKTREE", "BRANCH", "DEVICE"],
        listed.document.map((row) => [
          row.name ?? "",
          row.branch ?? "",
          row.device.name,
        ]),
        stdoutColor,
      ),
    );
  });
