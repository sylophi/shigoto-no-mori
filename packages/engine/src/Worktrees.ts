// A project's worktrees: which checkouts there are (their identities),
// what each one's row says (its sync, changes, commits and marks), the
// status card, finding the worktree a command means, and the marks and
// descriptions the app and agents set. The rows and documents keep the
// shapes `sm worktrees ... --json` prints, field for field.
import type { ProjectRow } from "@shigomori/contracts/schemas/project";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { type AgentSession } from "./agentSessions.ts";
import type { CheckoutUnfinished, HookFailed } from "./CloneCheckout.ts";
import * as Git from "./Git.ts";
import { splitRemoteRef } from "./gitParse.ts";
import * as Lifecycle from "./Lifecycle.ts";
import * as Registry from "./Registry.ts";
import type { RegisteredProject } from "./Registry.ts";
import type * as GitHub from "./GitHub.ts";
import { makeListing } from "./worktrees/listing.ts";
import { makeStatusCard } from "./worktrees/statusCard.ts";
import { makeResolving } from "./worktrees/resolving.ts";
import { makeDescribing } from "./worktrees/describing.ts";
import { makeCreating } from "./worktrees/creating.ts";
import { makeRemoving } from "./worktrees/removing.ts";
import { makeKept } from "./worktrees/kept.ts";
import { makeMoving } from "./worktrees/moving.ts";
import { makeAdopting } from "./worktrees/adopting.ts";
import { makeRelocating } from "./worktrees/relocating.ts";
import {
  CaptureNotCarried,
  CleanupFailed,
  type Created,
  DescribeRefused,
  type Described,
  type DescriptionView,
  DirtyWorktree,
  type Here,
  type IdentityRow,
  type Listing,
  type Located,
  MarkRefused,
  OrphanedWorktree,
  type PrimaryTarget,
  PullRequestNeedsTitle,
  PullRequestUnchecked,
  RelocateRefused,
  type Removed,
  type Reporter,
  type StatusCard,
  type Target,
  TargetError,
  UnknownWorktree,
  type WorktreeIdentity,
  WorktreeRefused,
  type WorktreeRow,
} from "./worktrees/documents.ts";
export {
  CaptureNotCarried,
  CleanupFailed,
  DescribeRefused,
  DirtyWorktree,
  MarkRefused,
  OrphanedWorktree,
  PullRequestNeedsTitle,
  PullRequestUnchecked,
  RelocateRefused,
  TargetError,
  UNKNOWN_BRANCH,
  UnknownWorktree,
  WorktreeRefused,
  cleanupErrorOf,
  cleanupFailureWords,
  isShelfable,
  projectsHint,
  scriptOf,
  trimGoSpace,
} from "./worktrees/documents.ts";
export type {
  Cloned,
  Created,
  DescriptionView,
  Here,
  IdentityRow,
  Listing,
  Located,
  PrimaryTarget,
  Removed,
  Reporter,
  StatusCard,
  Target,
  WorktreeEvent,
  WorktreeIdentity,
  WorktreeRow,
} from "./worktrees/documents.ts";

// --- the service ----------------------------------------------------------

export class Worktrees extends Context.Service<
  Worktrees,
  {
    // The project's checkouts in git's order. Not memoized: the host
    // lives long, and a checkout git adds behind its back must show.
    readonly identities: (
      project: RegisteredProject,
    ) => Effect.Effect<ReadonlyArray<WorktreeIdentity>, Git.GitError>;
    // Every project's identities, primary first, with their marks.
    readonly identityList: (
      projects: ReadonlyArray<RegisteredProject>,
      options: { readonly primaryRef: boolean },
    ) => Effect.Effect<Listing<IdentityRow>>;
    // One worktree's identity document.
    readonly identityRow: (
      located: Located,
      options: { readonly primaryRef: boolean },
    ) => Effect.Effect<IdentityRow>;
    // Every project's rows, primary first. Settles the shelf.
    readonly list: (
      projects: ReadonlyArray<RegisteredProject>,
    ) => Effect.Effect<Listing<WorktreeRow>>;
    // One worktree's row. `settle` settles its shelf as the listing does.
    readonly row: (
      located: Located,
      options?: { readonly settle?: boolean },
    ) => Effect.Effect<WorktreeRow>;
    readonly status: (
      located: Located,
      options: { readonly pullRequest: boolean },
    ) => Effect.Effect<StatusCard>;

    // Where `cwd` is among the registered projects.
    readonly here: (cwd: string) => Effect.Effect<Here>;
    // The project `ref` names (a name, an id, a path), or the one at the
    // cwd without one.
    readonly resolveProject: (
      here: Here,
      ref: string | undefined,
    ) => Effect.Effect<Registry.ListedProject, TargetError>;
    readonly resolveProjectById: (
      here: Here,
      projectId: string,
    ) => Effect.Effect<Registry.ListedProject, Registry.UnknownProject>;
    // The project a command names: by --project-id, else by -p, else the
    // one at the cwd. An empty flag is no flag.
    readonly resolveProjectRef: (
      here: Here,
      ref: Pick<Target, "project" | "projectId">,
    ) => Effect.Effect<
      Registry.ListedProject,
      TargetError | Registry.UnknownProject | Git.GitError
    >;
    // The worktree a command means. The reserved names root and primary
    // are the project's primary checkout.
    readonly resolve: (
      here: Here,
      target: Target,
    ) => Effect.Effect<
      Located,
      TargetError | UnknownWorktree | Registry.UnknownProject | Git.GitError
    >;

    readonly setShelved: (
      worktree: WorktreeIdentity,
      on: boolean,
    ) => Effect.Effect<void, MarkRefused>;
    readonly setAutoPull: (
      worktree: WorktreeIdentity,
      on: boolean,
    ) => Effect.Effect<void>;
    readonly description: (
      located: Located,
    ) => Effect.Effect<DescriptionView, DescribeRefused>;
    // What a script is told about the worktree it runs in.
    readonly scriptContext: (
      located: Located,
    ) => Effect.Effect<Lifecycle.ScriptContext>;
    // Sets the title, the description, or both: the open pull
    // request's while one holds them, else the worktree's own.
    readonly describe: (
      located: Located,
      change: { readonly title?: string; readonly description?: string },
    ) => Effect.Effect<
      Described,
      | DescribeRefused
      | PullRequestNeedsTitle
      | PullRequestUnchecked
      | GitHub.GitHubCliError
    >;

    // Where a new worktree named `name` (picked when empty) would go,
    // and whether a worktree or anything else already sits there.
    readonly destination: (
      project: RegisteredProject,
      name: string,
    ) => Effect.Effect<
      { readonly name: string; readonly path: string; readonly taken: boolean },
      WorktreeRefused | Git.GitError
    >;
    // A new managed worktree on a new branch (`branch`, else its name)
    // from `base`, or with `checkout` on the existing branch `base`, then
    // carry-over and its setup.
    readonly create: (
      project: RegisteredProject,
      input: {
        readonly name?: string | undefined;
        readonly branch?: string | undefined;
        readonly base?: string | undefined;
        readonly checkout?: boolean | undefined;
        readonly skipSetup?: boolean | undefined;
        // The agent session that creates the worktree to work in, bound
        // to it from the start.
        readonly agentSession?:
          | Pick<AgentSession, "harness" | "session" | "state">
          | undefined;
        // Clone the files from an existing checkout where it can (the
        // default), instead of having git write them all.
        readonly clone?: boolean | undefined;
      },
      reporter: Reporter,
    ) => Effect.Effect<
      Created,
      WorktreeRefused | CheckoutUnfinished | HookFailed | Git.GitError
    >;
    // Makes an external worktree a managed one: its branch checked out
    // again under the layout, its marks and title carried, set up as a
    // new worktree is.
    readonly adopt: (
      located: Located,
      options: { readonly force: boolean },
      reporter: Reporter,
    ) => Effect.Effect<
      Created,
      | WorktreeRefused
      | DirtyWorktree
      | OrphanedWorktree
      | CheckoutUnfinished
      | HookFailed
      | Git.GitError
    >;
    // Runs the setup half of making a worktree again.
    readonly setup: (
      located: Located,
      reporter: Reporter,
    ) => Effect.Effect<{
      readonly ran: ReadonlyArray<string>;
      readonly failures: ReadonlyArray<Lifecycle.ScriptFailure>;
    }>;
    // Port-pool's release and the teardown script, the checkout, what is
    // kept under its id, and its branch when the device's setting says so.
    // `preflighted` skips the dirty check a caller already ran with
    // checkRemovable. The primary checkout is refused regardless.
    readonly remove: (
      located: Located,
      options: {
        readonly force: boolean;
        readonly keepBranch: boolean;
        readonly skipCleanup: boolean;
        readonly preflighted?: boolean;
      },
      reporter: Reporter,
    ) => Effect.Effect<
      Removed,
      | WorktreeRefused
      | DirtyWorktree
      | CleanupFailed
      | OrphanedWorktree
      | Git.GitError
    >;
    // Whether removing `worktree` deletes its branch: never an external
    // or a detached one's, or one kept, else as the device's setting says.
    readonly deletesBranch: (
      worktree: WorktreeIdentity,
      keepBranch: boolean,
    ) => Effect.Effect<boolean>;
    // The guards every removal shares: never the primary checkout, and no
    // uncommitted or unreadable worktree unless forced.
    readonly checkRemovable: (
      located: Located,
      force: boolean,
    ) => Effect.Effect<void, WorktreeRefused | DirtyWorktree>;
    // Moves the checkout to `destination` (absolute), across volumes too,
    // and carries what is kept under its id to the new one.
    readonly move: (
      located: Located,
      destination: string,
    ) => Effect.Effect<
      { readonly worktree: WorktreeRow; readonly previousId: string },
      WorktreeRefused | Git.GitError
    >;
    // A move to the same parent under `name`, which is checked as a
    // custom name is at create.
    readonly rename: (
      project: RegisteredProject,
      worktreeId: string,
      name: string,
    ) => Effect.Effect<
      { readonly worktree: WorktreeRow; readonly previousId: string },
      WorktreeRefused | UnknownWorktree | Git.GitError
    >;
    // What a move carries once git lists the checkout at `toPath`: what
    // is kept under the old id, port-pool's lease, and a record of the
    // move, which the app follows to re-open a mirror rooted there.
    readonly carryMoved: (
      project: RegisteredProject,
      fromPath: string,
      toPath: string,
    ) => Effect.Effect<WorktreeRow, WorktreeRefused | Git.GitError>;
    // The moves a crash or an interrupt cut short, whose process is gone,
    // finished where git lists the checkout at its destination and undone
    // elsewhere (worktrees/moving.ts).
    readonly resumeMoves: Effect.Effect<void>;
    // Those moves, for the doctor to report.
    readonly interruptedMoves: Effect.Effect<
      ReadonlyArray<{
        readonly fromPath: string;
        readonly toPath: string;
        readonly projectId: string;
      }>
    >;
    // The project's primary ref (the default-branch setting honored),
    // its remote and local branch when it is a remote-tracking ref, and
    // the remotes that resolved it. An empty ref when none resolves.
    readonly primaryTarget: (
      project: RegisteredProject,
    ) => Effect.Effect<PrimaryTarget>;
    // Forgets what is kept under a gone worktree's id in one
    // transaction, all but its dirty capture, which may hold the only
    // copy of some work.
    readonly forgetKept: (
      project: RegisteredProject,
      worktreeId: string,
    ) => Effect.Effect<void>;
    // Worktrees moved by hand (old path to new) re-linked by git, what
    // each kept carried to its id there, and a failed repair said after.
    readonly relink: (
      project: RegisteredProject,
      moved: ReadonlyMap<string, string>,
    ) => Effect.Effect<void, Git.GitError | CaptureNotCarried>;
    // Whether anything is kept under an id (marks, sessions, the shelf,
    // its data, a dirty capture), the capture read strictly.
    readonly keptUnder: (
      project: RegisteredProject,
      worktreeId: string,
    ) => Effect.Effect<boolean, Git.GitError | Git.RefUnreadable>;
    // Where each managed worktree would go under `proposed` layout
    // settings, and whether it is there already, by the folder's identity.
    readonly relocationPlan: (
      project: RegisteredProject,
      proposed: {
        readonly worktreeLayout?: string | undefined;
        readonly customWorktreePath?: string | undefined;
      },
    ) => Effect.Effect<
      ReadonlyArray<{
        readonly worktreeId: string;
        readonly destination: string;
        readonly inPlace: boolean;
      }>,
      Git.GitError
    >;
    // Carries what is kept under `from` to the id a checkout at `toPath`
    // (absolute) will have, ahead of moving it there. Answers that id.
    // `expect` names the dirty capture to carry by its commit (null:
    // none), as its caller saw it: a different one under `from` fails the
    // re-key (`changed`). `back` is an undo's, which leaves a changed one,
    // or one kept at `toPath`'s id, where it is.
    readonly rekey: (
      project: RegisteredProject,
      from: string,
      toPath: string,
      options?: { readonly expect?: string | null; readonly back?: boolean },
    ) => Effect.Effect<string, CaptureNotCarried>;
    // Points a project whose repo was moved or renamed by hand at where
    // it is now (an absolute path, any folder inside it will do), keeping
    // its id. The
    // linked worktrees that moved along are re-linked, and the managed
    // ones a rename would leave external move to where new ones go.
    // Answers the project's row.
    readonly relocateProject: (
      project: Registry.ListedProject,
      destination: string,
    ) => Effect.Effect<
      ProjectRow,
      RelocateRefused | Registry.UnknownProject | Registry.ProjectPathTaken
    >;
  }
>()("sm/engine/Worktrees") {}

const make = Effect.gen(function* () {
  const listing = yield* makeListing;
  const statusCard = yield* makeStatusCard({ listing });
  const resolving = yield* makeResolving({ listing });
  const describing = yield* makeDescribing({ listing });
  const kept = yield* makeKept;
  const creating = yield* makeCreating({ listing, statusCard, kept });
  const removing = yield* makeRemoving({ listing, creating, kept });
  const moving = yield* makeMoving({ listing, creating, removing, kept });
  const adopting = yield* makeAdopting({ listing, creating, removing, kept });
  const relocating = yield* makeRelocating({ listing, kept, moving });
  const { identities, primaryRefOf, list, row, identityList, identityRow } =
    listing;
  const { status } = statusCard;
  const {
    locate,
    resolveProject,
    resolveProjectById,
    resolveProjectRef,
    resolve,
  } = resolving;
  const { setShelved, setAutoPull, description, describe } = describing;
  const { destination, scriptContext, create } = creating;
  const { removable, remove } = removing;
  const { move, carryMoved, rename, rekey, resume, interrupted } = moving;
  const { adopt, setup } = adopting;
  const { relocateProject, relocationPlan, relink } = relocating;

  return Worktrees.of({
    identities,
    identityList,
    identityRow,
    list,
    row,
    status,
    here: locate,
    resolveProject,
    resolveProjectById,
    resolveProjectRef,
    resolve,
    setShelved,
    setAutoPull,
    description,
    scriptContext: Effect.fn("Worktrees.scriptContext")(function* ({
      project,
      worktree,
    }: Located) {
      return yield* scriptContext(project, worktree);
    }),
    describe,
    destination,
    create,
    adopt,
    setup,
    remove,
    move,
    rename,
    carryMoved,
    resumeMoves: resume,
    interruptedMoves: interrupted,
    rekey,
    forgetKept: kept.forgetRows,
    keptUnder: kept.keptUnder,
    relocateProject,
    deletesBranch: removing.deletesBranch,
    relocationPlan,
    relink,
    checkRemovable: Effect.fn("Worktrees.checkRemovable")(function* (
      located: Located,
      force: boolean,
    ) {
      yield* removable(located.worktree, force);
    }),
    primaryTarget: Effect.fn("Worktrees.primaryTarget")(function* (
      project: RegisteredProject,
    ) {
      const { remotes, primaryRef, primaryBranch } =
        yield* primaryRefOf(project);
      return {
        remotes,
        primaryRef,
        remote: splitRemoteRef(primaryRef, remotes)?.remote ?? "",
        primaryBranch,
      };
    }),
  });
});

export const layer = Layer.effect(Worktrees, make);
