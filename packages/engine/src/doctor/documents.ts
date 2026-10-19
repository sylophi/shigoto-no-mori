// The doctor's document, findings and the pure helpers its areas share (EFFECT.md, section 2). `Doctor.ts` re-exports what consumers use.
import type {
  DoctorFinding,
  DoctorReport,
} from "@shigomori/contracts/modules/cli";
import { RegistryFileSchema } from "@shigomori/contracts/schemas/dataDir";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as SqlClient from "effect/sql/SqlClient";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as CloneCheckout from "../CloneCheckout.ts";
import * as Config from "../Config.ts";
import type { ConfigDoc } from "../configDoc.ts";
import * as Darwin from "../Darwin.ts";
import * as Git from "../Git.ts";
import type { CommandTimedOut } from "../processes.ts";
import { decodedLaunchers } from "../Launchers.ts";
import * as Layout from "../Layout.ts";
import { StoreImportError } from "../migrations/importJson.ts";
import * as Registry from "../Registry.ts";
import * as RunningScripts from "../RunningScripts.ts";
import {
  StagingLockUnavailable,
  stagingHolder,
  UpdateInProgress,
} from "../stagingLock.ts";
import type { ListedProject } from "../Registry.ts";
import * as Terrier from "../Terrier.ts";
import { terrierProjects } from "../Terrier.ts";
import * as WorktreeData from "../WorktreeData.ts";
import * as Worktrees from "../Worktrees.ts";
import { type WorktreeIdentity } from "../Worktrees.ts";
import * as WtFolder from "../WtFolder.ts";
// --- the document ---------------------------------------------------------

export type Status = "ok" | "warn" | "fail";

// The groups in the order they print: broadest blast radius first.
export type Group = "Environment" | "Data dir" | "Processes" | "Projects";

// One line of the checklist. `detail` explains it, `fix` suggests what
// to do (absent when there is nothing to suggest), and `repairable` says
// the fix can apply a repair for it. The fields the app reads are the
// contracts' (DoctorFindingSchema).
export type Finding = DoctorFinding & {
  readonly group: Group;
  readonly repairable?: true;
};

// A repair as the terminal asks about it: the yes/no question for a
// destructive one, and the past-tense line reported once it ran.
export type Repair = {
  readonly prompt: string;
  readonly label: string;
  readonly destructive: boolean;
};

// The run as `sm doctor --json` prints it, the app's DoctorReport and
// the rest. `repaired` holds the labels of the repairs that ran, and
// `repairFailed` a "couldn't <label>: <why>" line for each that failed.
export type DoctorDocument = Omit<DoctorReport, "checks"> & {
  readonly ok: boolean;
  readonly dataDir: string;
  readonly flavor: string;
  readonly version: string;
  readonly binary: string;
  readonly checks: ReadonlyArray<Finding>;
};

export type RunInput = {
  // This build's version, which the app bundle and the update files are
  // compared against.
  readonly version: string;
  // The running binary, which a prod build expects inside the app.
  readonly executable: string;
  // Whether a person is at a terminal, which makes a shell hook that
  // isn't active in this session worth a word.
  readonly terminal: boolean;
  // Apply the repairs, a destructive one only once `approve` says yes.
  // `failed` hears each "couldn't <label>: <why>" line as it happens,
  // in checklist order.
  readonly fix?: {
    readonly approve: (repair: Repair) => Effect.Effect<boolean>;
    readonly failed: (line: string) => Effect.Effect<void>;
  };
};

// A moved worktree still waits to be re-linked, which a prune would
// sever.
export class MovedWorktreePending extends Schema.TaggedError<MovedWorktreePending>()(
  "MovedWorktreePending",
  { project: Schema.String },
) {
  override get message(): string {
    return `a moved worktree in ${this.project} needs re-linking first (\`git worktree repair <new path>\`)`;
  }
}

// A v2 worktree the retried move still couldn't take.
// port-pool refused to lease a worktree its ports.
export class LeaseRefused extends Schema.TaggedError<LeaseRefused>()(
  "LeaseRefused",
  { worktree: Schema.String, code: Schema.Int },
) {
  override get message(): string {
    return `port-pool ensure for ${this.worktree} exited with ${this.code}`;
  }
}

export class WorktreesNotMoved extends Schema.TaggedError<WorktreesNotMoved>()(
  "WorktreesNotMoved",
  { why: Schema.String },
) {
  override get message(): string {
    return this.why;
  }
}

type RepairError =
  | Worktrees.CaptureNotCarried
  | WorktreesNotMoved
  | LeaseRefused
  | CommandTimedOut
  | Git.GitError
  | PlatformError.PlatformError
  | MovedWorktreePending
  | UpdateInProgress
  | StagingLockUnavailable
  // A prune that couldn't read the managed folders, so couldn't rule out
  // a moved worktree it would sever.
  | Darwin.DarwinHelperError;

// --- helpers --------------------------------------------------------------

// What the checks that read the store need.
export type StoreServices =
  | SqlClient.SqlClient
  | CloneCheckout.CloneCheckout
  | Config.Config
  | Layout.Layout
  | Registry.Registry
  | RunningScripts.RunningScripts
  | Terrier.Terrier
  | Worktrees.Worktrees
  | WorktreeData.WorktreeData
  | WtFolder.WtFolder;

export const isStoreImportError = Schema.is(StoreImportError);

// The lines that judge the 2.x files, read as Go read them, while the
// store can't import them: config.json's, registry.json's, state.json's
// when there is one, the store's own for a refused file none of them
// names, and each registered project's project.json by project id.
export type FileReads = {
  readonly config: Entry;
  readonly registry: Entry;
  readonly state: ReadonlyArray<Entry>;
  readonly refused: ReadonlyArray<Entry>;
  readonly projectFiles: ReadonlyMap<string, Entry>;
};

// A finding and its repair, which may need the store's services (`R`).
// `writesStore` marks a repair that changes what the store keeps.
export type Entry<R = never> = Finding & {
  readonly repair?: Repair & {
    readonly apply: Effect.Effect<void, RepairError, R>;
    readonly writesStore?: true;
  };
};

// One check's lines, by its group, id and title. An empty fix is left
// out, as Go's omitempty does.
export const check = (group: Group, id: string, title: string) => {
  const line = (status: Status, detail: string, fix: string): Entry => ({
    group,
    id,
    title,
    status,
    detail,
    ...(fix === "" ? {} : { fix }),
  });
  return {
    ok: (detail: string) => line("ok", detail, ""),
    warn: (detail: string, fix: string) => line("warn", detail, fix),
    fail: (detail: string, fix: string) => line("fail", detail, fix),
  };
};

export const repairable = <R = never>(
  finding: Entry,
  repair: NonNullable<Entry<R>["repair"]>,
): Entry<R> => ({ ...finding, repairable: true, repair });

export const counts = (entries: ReadonlyArray<Entry<unknown>>) => ({
  ok: entries.filter(({ status }) => status === "ok").length,
  warn: entries.filter(({ status }) => status === "warn").length,
  fail: entries.filter(({ status }) => status === "fail").length,
});

// The finding as the document prints it, without its repair.
export const findingOf = ({ repair: _, ...finding }: Entry<unknown>): Finding =>
  finding;

// What a failure says, git's own words for a git that failed.
export const errorText = (error: { readonly message: string }) =>
  error instanceof Git.GitCommandError
    ? `git ${error.subcommand}: ${Git.stderrOf(error).trim()}`
    : error.message;

export const isDirMode = (mode: number) =>
  (mode & Darwin.S_IFMT) === Darwin.S_IFDIR;

// A stat's mtime, epoch ms.
export const lstatMtime = (entry: Darwin.LstatEntry) =>
  entry.mtimeSec * 1000 + Math.floor(entry.mtimeNsec / 1e6);

// Who holds the update stager's pidfile, read once a pass.
export type Holder = Effect.Success<ReturnType<typeof stagingHolder>>;

export const mtimeOf = (info: FileSystem.File.Info) =>
  Option.match(info.mtime, {
    onNone: () => 0,
    onSome: (date) => date.getTime(),
  });

// A lock older than this belonged to a process that died holding it:
// the writes they guard take milliseconds.
export const LOCK_STALE_MS = 10_000;
// A transfer's landing ref older than this can only be a leftover: a
// landing sweeps it within seconds.
export const INCOMING_REF_STALE_MS = 60 * 60 * 1000;
// ps reports a start time to the second, stamped just after spawn.
export const SCRIPT_START_TOLERANCE_MS = 5_000;

// A JSON file the store imports, read as an object.
export const JsonObjectText = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Unknown),
);

// A JSON file as Go read it: absent, unreadable, not a JSON object, or
// the object.
export type JsonFile =
  | { readonly state: "absent" }
  | { readonly state: "unreadable"; readonly why: string }
  | { readonly state: "invalid" }
  | { readonly state: "parsed"; readonly doc: ConfigDoc };

// The registry's projects as the store imports them, and its manual
// order as Go read it.
export const RegistryProjects = Schema.UndefinedOr(
  RegistryFileSchema.fields.projects,
);
export const ProjectOrder = Schema.UndefinedOr(
  Schema.NullOr(Schema.Array(Schema.String)),
);

// The update stager's manifest of what it staged.
export const StagedManifest = Schema.fromJsonString(
  Schema.Struct({ version: Schema.optional(Schema.String) }),
);

const textAt = (doc: Readonly<Record<string, unknown>> | null, key: string) => {
  const value = doc?.[key];
  return typeof value === "string" ? value : "";
};

// The carry-over entries' paths, every entry the settings list, as Go
// checks them: one create would skip still fails the check.
export const carryOverPaths = (settings: ConfigDoc | null) => {
  const value = settings?.["carryOver"];
  return Array.isArray(value)
    ? value.filter(Predicate.isObject).map((entry) => textAt(entry, "path"))
    : [];
};

export const launcherCommands = (doc: ConfigDoc | null) =>
  decodedLaunchers(doc).custom.map(({ label, command }) => ({
    label: label ?? "",
    command: command ?? "",
  }));

// What a project's checks found, and its checkouts when they could be
// listed, which the bookkeeping line reads again.
export type ProjectChecked = {
  readonly entries: ReadonlyArray<Entry<StoreServices>>;
  readonly identities: Option.Option<ReadonlyArray<WorktreeIdentity>>;
};

// The registry's projects, then terrier's, as every command sees them.
// A terrier listing that failed leaves the list short, so the checks
// that read "nothing claims this" as a leftover stand down.
export const listProjects = (listing: Terrier.TerrierListing) =>
  Effect.gen(function* () {
    const registry = yield* Registry.Registry;
    const registered = yield* registry.projects;
    const extras = terrierProjects(
      new Set(registered.map(({ path: at }) => at)),
      listing.paths,
    );
    return {
      projects: [...registered, ...extras] as ReadonlyArray<ListedProject>,
      complete: Option.isNone(listing.trouble),
    };
  });
