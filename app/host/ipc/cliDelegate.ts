// The calls that still go to the bundled CLI, until the engine has
// services for them: the dirty capture and apply, the bundle create and
// unpack of the device sync, and opening a launcher. Each runs
// `sm --json ...` and validates the document crossing the Go/TS
// boundary against a schema, so drift fails loudly here instead of
// surfacing as undefined-flavored breakage in the renderer.
import * as Schema from "effect/Schema";
import { CommitHashSchema, type Project } from "@shigomori/contracts/schemas";
import {
  UnknownProjectError,
  UnknownWorktreeError,
} from "@shigomori/contracts/errors";
import { implSlot } from "@host/lib/util/implSlot";

// One NDJSON document from the CLI's --json stream. `event` is set on
// streamed progress documents (created/phase/carryOver/script/done);
// single-document commands (rm, done, merge) emit result objects
// without it.
export interface CliDoc {
  event?: string;
  [key: string]: unknown;
}

export interface CliResult {
  code: number;
  docs: CliDoc[];
  stderrTail: string;
}

// The electron layer injects the CLI process runner at boot. Spawning
// stays in main/electron (the runner resolves the binary through
// Electron's packaging paths and registers children with quit-time
// reaping), so this seam owns the document shapes and the delegate
// stays free of Electron imports.
// opts.signal cancels the run: the child (and the lifecycle script it
// may be running) is killed, and the run closes non-zero like any
// failure. Only the verbs a cancellable move drives pass one.
export type CliRunOpts = {
  background?: boolean;
  readOnly?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type CliRunnerImpl = {
  runCli: (
    args: string[],
    onDoc?: (doc: CliDoc) => void,
    extraEnv?: Record<string, string>,
    opts?: CliRunOpts,
  ) => Promise<CliResult>;
  requireCliBinary: () => string;
  cliFailureMessage: (result: CliResult, fallback: string) => string;
};

const { set: setCliRunnerImpl, get: runner } = implSlot<CliRunnerImpl>(
  "cli delegate invoked before setCliRunnerImpl registered one",
);
export { setCliRunnerImpl };

// The argv of a verb that acts on one worktree of one project.
function worktreeArgv(
  verb: string[],
  project: Project,
  worktreeId: string,
): string[] {
  return [...verb, "--project-id", project.id, "--worktree-id", worktreeId];
}

// The failure for a run that produced no ok result. The CLI's --json
// error document carries a stable `code` for entity-gone failures,
// which become the contract's error classes here, so the renderer
// branches on their tag, not on the CLI's prose.
function cliFailure(
  result: CliResult,
  fallback: string,
  ids: { projectId?: string; worktreeId?: string } = {},
): Error {
  const code = result.docs.find(isErrorDoc)?.["code"];
  if (code === "unknown-project" && ids.projectId !== undefined) {
    return new UnknownProjectError({ projectId: ids.projectId });
  }
  if (code === "unknown-worktree" && ids.worktreeId !== undefined) {
    return new UnknownWorktreeError({ worktreeId: ids.worktreeId });
  }
  return new Error(runner().cliFailureMessage(result, fallback));
}

// A read's document can be an array or null, not only an object.
function isErrorDoc(doc: unknown): doc is CliDoc {
  return (
    typeof doc === "object" &&
    doc !== null &&
    (doc as Record<string, unknown>)["ok"] === false
  );
}

// The final {ok: boolean} document of a run; throws the mapped failure
// when the run never produced a successful result.
function finalOkDoc(
  result: CliResult,
  fallback: string,
  ids: { projectId?: string; worktreeId?: string } = {},
): CliDoc {
  const final = result.docs.findLast((doc) => typeof doc["ok"] === "boolean");
  if (final?.["ok"] !== true) throw cliFailure(result, fallback, ids);
  return final;
}

// The device-sync verbs. Each shells the CLI and
// re-validates the crossing document with a schema, like every
// other Go/TS boundary in this file. The paths handed to bundle
// create/unpack are ALWAYS app-chosen temp paths (the source link,
// host/lib/sync/sourceLink.ts, owns them); the CLI writes/reads exactly where told,
// so path discipline lives on this side of the trust boundary.

// A capture doc carries its commit; a clean worktree omits it. The
// check makes a captured:true document WITHOUT a commit an engine
// drift error here, never a silent "clean" report.
const decodeDirtyCaptured = Schema.decodeUnknownSync(
  Schema.Struct({
    captured: Schema.Boolean,
    commit: Schema.optional(Schema.String),
  }).check(
    Schema.makeFilter(
      (d) =>
        !d.captured || d.commit !== undefined || "captured without a commit",
    ),
  ),
);

export async function dirtyCaptureViaCli(
  project: Project,
  worktreeId: string,
): Promise<{ captured: boolean; commit?: string }> {
  const result = await runner().runCli(
    worktreeArgv(["dirty", "capture"], project, worktreeId),
  );
  const final = finalOkDoc(result, "sm dirty capture failed", {
    projectId: project.id,
    worktreeId,
  });
  const doc = decodeDirtyCaptured(final);
  return doc.captured
    ? { captured: true, commit: doc.commit }
    : { captured: false };
}

// Mirrors dirtyCaptureViaCli: replays refs/shigomori/dirty/<id> onto
// the worktree and consumes the ref (`sm dirty apply`, cli/cmd_dirty.go).
// The CLI's own guards (HEAD must be the capture's parent, tree clean,
// no added-path collisions) are the failure surface here.
const decodeDirtyApplied = Schema.decodeUnknownSync(
  Schema.Struct({
    applied: Schema.Literal(true),
    commit: CommitHashSchema,
    changedFiles: Schema.Natural,
  }),
);

export async function dirtyApplyViaCli(
  project: Project,
  worktreeId: string,
): Promise<{ applied: boolean; commit: string; changedFiles: number }> {
  const result = await runner().runCli(
    worktreeArgv(["dirty", "apply"], project, worktreeId),
  );
  const final = finalOkDoc(result, "sm dirty apply failed", {
    projectId: project.id,
    worktreeId,
  });
  return decodeDirtyApplied(final);
}

const RefTipDocSchema = Schema.Struct({
  ref: Schema.String,
  commit: CommitHashSchema,
});
const decodeBundleCreated = Schema.decodeUnknownSync(
  Schema.Struct({ bytes: Schema.Natural, refs: Schema.Array(RefTipDocSchema) }),
);
const decodeBundleUnpacked = Schema.decodeUnknownSync(
  Schema.Struct({ fetched: Schema.mutable(Schema.Array(RefTipDocSchema)) }),
);

export async function bundleCreateViaCli(
  project: Project,
  outPath: string,
  refs: string[],
  haves: string[],
): Promise<{
  bytes: number;
  refs: readonly { ref: string; commit: string }[];
}> {
  const result = await runner().runCli([
    "bundle",
    "create",
    "--project-id",
    project.id,
    "--out",
    outPath,
    ...refs.flatMap((ref) => ["--ref", ref]),
    ...haves.flatMap((have) => ["--have", have]),
  ]);
  const final = finalOkDoc(result, "sm bundle create failed", {
    projectId: project.id,
  });
  return decodeBundleCreated(final);
}

// Into a registered project, or into a repository by path: the clone
// from a peer (host/lib/sync/cloneFromPeer.ts) unpacks into a folder
// it registers only once it is a checkout.
export async function bundleUnpackViaCli(
  target: Project | { path: string },
  inPath: string,
  refspecs: string[],
): Promise<{ fetched: { ref: string; commit: string }[] }> {
  const project = "id" in target ? target : undefined;
  const result = await runner().runCli([
    "bundle",
    "unpack",
    ...(project ? ["--project-id", project.id] : ["--repo", target.path]),
    "--in",
    inPath,
    ...refspecs.flatMap((spec) => ["--refspec", spec]),
  ]);
  const final = finalOkDoc(result, "sm bundle unpack failed", {
    projectId: project?.id,
  });
  return decodeBundleUnpacked(final);
}

// Launches a launcher-row entry (`app:…`, `custom:…`, `web:github`) in
// the worktree through `sm open`, which also counts the use.
export async function openLauncherViaCli(
  project: Project,
  worktreeId: string,
  launcherId: string,
): Promise<void> {
  const result = await runner().runCli([
    ...worktreeArgv(["open"], project, worktreeId),
    "--",
    launcherId,
  ]);
  finalOkDoc(result, "sm open failed", { projectId: project.id, worktreeId });
}

// The bundled `sm`, which the doctor's app check compares against the
// installed bundle.
export const cliBinary = () => runner().requireCliBinary();
