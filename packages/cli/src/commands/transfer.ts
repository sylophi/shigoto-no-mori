// The cross-device verbs over the engine's Transfer, which the running
// app carries out: send and bring move a worktree, mirror keeps a copy
// in step, unmirror stops one, mirrors and devices list. The remote
// listing (`list --remote`, `--from`) is here too.
import * as Transfer from "@shigomori/engine/Transfer";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import { ExitCode, UsageError } from "../errors.ts";
import { given, here, projectFlags, worktreeFlags } from "../here.ts";
import { emit, note, out, Output, renderTable, styles } from "../output.ts";

// A flag as Go read it: absent, or given (blank included).
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
  // Go reads the first positional and lets the rest be.
  rest: Argument.String("args").pipe(Argument.variadic()),
  to: Flag.String("to").pipe(
    Flag.withDescription("The device it goes to"),
    Flag.optional,
  ),
  from: Flag.String("from").pipe(
    Flag.withDescription("The device it comes from"),
    Flag.optional,
  ),
  leaveOut: Flag.String("leave-out").pipe(
    Flag.withDescription("nothing or gitignored"),
    Flag.optional,
  ),
  source: Flag.String("source").pipe(
    Flag.withDescription(
      "What becomes of the original: keep, shelve or teardown",
    ),
    Flag.optional,
  ),
  cloneInto: Flag.String("clone-into").pipe(
    Flag.withDescription("Where the other device clones the repo, lacking it"),
    Flag.optional,
  ),
  setup: Flag.Boolean("setup").pipe(
    Flag.withDescription("Run the setup script on the copy"),
    Flag.withDefault(false),
  ),
  noSetup: Flag.Boolean("no-setup").pipe(
    Flag.withDescription("Don't run the setup script on the copy"),
    Flag.withDefault(false),
  ),
};

type TransferInput = Command.Command.Config.Infer<typeof transferFlags>;

// Each step once on stderr, or every frame as an event under --json.
const onProgress = Effect.map(
  Effect.service(Output),
  ({ json, stderrColor }): Transfer.OnProgress =>
    ({ document, line }) =>
      json
        ? document === undefined
          ? Effect.void
          : emit(document)
        : line === undefined
          ? Effect.void
          : note(styles(stderrColor).dim(`  ${line}`)),
);

// What a source whose fate was carried out became.
const FATE_DONE: Readonly<Record<string, string>> = {
  shelve: "shelved",
  teardown: "removed",
};

// A finished transfer: the story on stderr and the copy's path alone on
// stdout, as create's, so `cd "$(sm bring <name>)"` works. A copy on the
// other device has no path here, so it is part of the story. It exits 3
// with a caveat, which a script mustn't read as a clean run.
const report = ({ document, headline, result }: Transfer.Transferred) =>
  Effect.gen(function* () {
    const { json, stderrColor } = yield* Effect.service(Output);
    const { dim, green, yellow } = styles(stderrColor);
    const code = document.caveats.length > 0 ? 3 : 0;
    if (json) {
      yield* emit(document);
    } else {
      yield* note(green(headline));
      if (result.captured && result.dirtyApplied) {
        yield* note(dim("  uncommitted changes went along"));
      }
      if (result.files?.crossed === true) {
        yield* note(dim("  ignored files went along"));
      }
      const source = result.source;
      if (source !== undefined && source.done && source.fate !== "keep") {
        yield* note(dim(`  source ${FATE_DONE[source.fate] ?? ""}`));
      }
      for (const caveat of document.caveats) {
        yield* note(yellow(`! ${caveat}`));
      }
      if (result.copySide === "local") {
        yield* out(result.worktree.path);
      } else {
        yield* note(
          dim(`  at ${result.worktree.path} on "${result.device.name}"`),
        );
      }
    }
    if (code !== 0) return yield* new ExitCode({ code });
  });

const transferVerb = (name: "send" | "bring" | "mirror", description: string) =>
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
      const done = yield* transfer[name](
        at,
        target(input),
        flags,
        yield* onProgress,
      );
      yield* report(done);
    }),
  ).pipe(Command.withDescription(description));

export const send = transferVerb("send", "Move a worktree to another device");
export const bring = transferVerb(
  "bring",
  "Move another device's worktree here",
);
export const mirror = transferVerb(
  "mirror",
  "Keep a copy of a worktree in step on another device",
);

export const unmirror = Command.make(
  "unmirror",
  {
    ...worktreeFlags,
    ref: Argument.String("worktree").pipe(Argument.optional),
    rest: Argument.String("args").pipe(Argument.variadic()),
    force: Flag.Boolean("force").pipe(
      Flag.withAlias("f"),
      Flag.withDescription("Stop it even if the two sides aren't in step"),
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
).pipe(Command.withDescription("Stop a mirror and remove its copy"));

export const mirrors = Command.make(
  "mirrors",
  { rest: Argument.String("args").pipe(Argument.variadic()) },
  ({ rest }) =>
    Effect.gen(function* () {
      if (rest.length > 0) {
        return yield* new UsageError({
          problem: "mirrors takes no arguments.",
        });
      }
      const listed = yield* (yield* Transfer.Transfer).mirrors;
      const { json, stdoutColor, stderrColor } = yield* Effect.service(Output);
      if (json) return yield* emit(listed);
      if (listed.daemon !== "running") {
        yield* note(
          styles(stderrColor).yellow(`! the mirror engine is ${listed.daemon}`),
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
).pipe(Command.withDescription("The mirrors this device is part of"));

const BLOCKS: Readonly<Record<string, string>> = {
  offline: "not connected",
  "no-project": "no checkout yet; a send clones the repo there",
  "no-grant": "doesn't accept commands",
};

export const devices = Command.make("devices", projectFlags, (input) =>
  Effect.gen(function* () {
    const at = yield* here;
    const ref = {
      project: Option.getOrUndefined(given(input.project)),
      projectId: Option.getOrUndefined(given(input.projectId)),
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
              : yellow(BLOCKS[block] ?? block),
          ];
        }),
        stdoutColor,
      ),
    );
  }),
).pipe(Command.withDescription("The account's other devices"));

// list --remote [--from <device>]: the project's worktrees on the other
// devices, the names bring and mirror --from take.
export const listRemote = (input: {
  readonly project: Option.Option<string>;
  readonly from: Option.Option<string>;
}) =>
  Effect.gen(function* () {
    const listed = yield* (yield* Transfer.Transfer).peerWorktrees(
      yield* here,
      {
        project: Option.getOrUndefined(given(input.project)),
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
