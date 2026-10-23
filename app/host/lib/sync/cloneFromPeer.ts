// A checkout of a repo made on this device from another device's copy,
// over the device link: a landing's project when this device has none
// (a pull's `cloneInto`, or a send's, where the landing runs here on
// the source's behalf). The source's default branch crosses as a
// bundle on the same source link the branch itself then does
// (sourceLink.ts), so a repo with no remote gets here too, and the
// link's grant is the one gate. The bundle unpacks into a fresh
// repository at the folder asked for, the branch is checked out, the
// source's remote is set up when it has one, and the checkout is
// registered the way the add-project dialog's clone is (`sm projects
// add`, config seed included, which is why the register waits for the
// checkout). The repository is built in a sibling of the folder asked
// for and renamed in once whole, then registered, the two uninterrupted,
// so the folder asked for is either the clone, registered, or not
// there. Up to the rename everything is undone on failure, and a sibling
// a crash left is swept by the next clone of the same name. A checkout
// of the same repo already at the folder (one made by hand, the way the
// source's was) is registered as it is and landed in, its files
// untouched.
import { isCloneableRemote } from "@shigomori/contracts/predicates/remoteUrl";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  SyncBundleRefSchema,
  type SyncCloneInto,
} from "@shigomori/contracts/modules/sync";
import * as Git from "@shigomori/engine/Git";
import { errnoWords } from "@shigomori/engine/platformErrors";
import { pidAlive } from "@shigomori/engine/processes";
import { expandHome } from "@shared/paths";
import { repoIdentity } from "@host/lib/engineOps";
import { landingRefOf, type WorktreeSource } from "./sourceLink";
import { errorMessageOf } from "@shigomori/contracts/errors";

const decodeBundleRef = Schema.decodeSync(SyncBundleRefSchema);

// Inside a clone's .git, from just before its rename until its register:
// the folder and the repo (its identity) it is a clone of, which a retry
// of the same repo into the same folder registers.
const PENDING = "sm-clone-pending";
const Pending = Schema.fromJsonString(
  Schema.Struct({ dest: Schema.String, identity: Schema.String }),
);

const pendingIn = (dir: string) =>
  Effect.promise(() =>
    readFile(join(dir, ".git", PENDING), "utf8").then(
      (text) => Option.getOrNull(Schema.decodeUnknownOption(Pending)(text)),
      () => null,
    ),
  );

const finishRegister = <A, E, R>(
  dest: string,
  register: (dest: string) => Effect.Effect<A, E, R>,
) =>
  Effect.tap(register(dest), () =>
    Effect.promise(() =>
      rm(join(dest, ".git", PENDING), { force: true }).catch(() => {}),
    ),
  );

// The siblings `.name.partial-<pid>` whose process is gone.
const sweepPartials = (parent: string, name: string) =>
  Effect.gen(function* () {
    const prefix = `.${name}.partial-`;
    const entries = yield* Effect.promise(() =>
      readdir(parent).catch((): string[] => []),
    );
    for (const entry of entries) {
      const pid = Number(entry.slice(prefix.length));
      if (
        entry.startsWith(prefix) &&
        Number.isInteger(pid) &&
        pid > 1 &&
        !(yield* pidAlive(pid))
      ) {
        yield* Effect.promise(() =>
          rm(join(parent, entry), { recursive: true, force: true }),
        );
      }
    }
  });

// What is at the folder a clone would go to: nothing, a checkout of
// the same repo, or anything else.
export const cloneDestination = (
  { parentDir, name }: SyncCloneInto,
  identity: string | null,
) =>
  Effect.gen(function* () {
    const dest = join(expandHome(parentDir), name);
    const there = yield* Effect.promise(() =>
      lstat(dest).then(
        () => true,
        () => false,
      ),
    );
    if (!there) return "free" as const;
    return identity !== null && (yield* repoIdentity(dest)) === identity
      ? ("same-repo" as const)
      : ("taken" as const);
  });

// An interrupt (the move's cancel) undoes the sibling like any failure.
// During the fetch the link's reset does the failing. `register` makes
// the checkout a project, right after the rename; answers what it does.
export const cloneCheckoutFromPeer = Effect.fnUntraced(function* <A, E, R>(
  source: WorktreeSource,
  { parentDir, name }: SyncCloneInto,
  // The branch the landing puts its copy on afterwards: the clone's own
  // branch cannot be it, and that is known before a byte moves.
  landing: string,
  // The repo's identity, which a clone a crash left must match to be
  // taken for this one.
  identity: string,
  register: (dest: string) => Effect.Effect<A, E, R>,
  onProgress?: (bytes: number, totalBytes: number) => void,
) {
  // The source's default branch is what the checkout is made of: its
  // ref there, checked out here as the local branch it names. So the
  // clone reads as the repo (its identity is the root of that branch,
  // packages/engine/src/Identity.ts) and not as one worktree of it. The
  // remote it was cloned from comes along when it has one, so the
  // clone is what a clone of that remote would be, and reads as the
  // same repo even when its default branch is only the remote's HEAD
  // to go by. Both re-parsed by the link: they flow into refs and argv
  // here. The parent is made if need be: the dialog's default is the
  // source's own layout, which this machine may not have yet. A parent
  // that cannot be made (a file in its place) is the destination
  // check's to name.
  const parent = expandHome(parentDir);
  yield* Effect.promise(() =>
    mkdir(parent, { recursive: true }).catch(() => {}),
  );
  // A clone a crash left renamed in but not registered: registered now.
  const left = join(parent, name);
  const pending = yield* pendingIn(left);
  if (pending?.dest === left && pending.identity === identity) {
    return yield* finishRegister(left, register);
  }
  if (
    (yield* cloneDestination({ parentDir, name }, identity)) === "same-repo"
  ) {
    return yield* register(left);
  }
  const [dest, { branch, ref, remoteUrl }] = yield* Effect.all(
    [
      Effect.flatMap(Git.Git, (git) => git.checkDestination(parent, name)),
      source.cloneFacts,
    ],
    { concurrency: 2 },
  );
  if (
    landing === branch ||
    landing.startsWith(`${branch}/`) ||
    branch.startsWith(`${landing}/`)
  ) {
    return yield* new Git.GitRefusedError({
      reason: `The copy would land on ${landing}, which the clone here checks out as the repo's default branch. Bring a worktree on another branch, or mirror the primary checkout.`,
    });
  }
  const branchRef = decodeBundleRef(`refs/heads/${branch}`);
  const incomingRef = landingRefOf(ref);
  yield* sweepPartials(parent, name);
  const partial = join(parent, `.${name}.partial-${process.pid}`);
  const removePartial = Effect.promise(() =>
    rm(partial, { recursive: true, force: true }).catch(() => {}),
  );

  return yield* Effect.scoped(
    Effect.gen(function* () {
      // Made and let go of in one scope, so no cancel leaves it behind: after
      // the rename the release finds nothing there.
      yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => mkdir(partial),
          catch: (error) =>
            new Git.GitRefusedError({
              reason: `Couldn't make ${dest}: ${errnoWords(error, errorMessageOf(error))}.`,
            }),
        }),
        () => removePartial,
      );
      yield* Effect.gen(function* () {
        const git = yield* Git.Git;
        yield* git.run(partial, ["init", "--quiet"]);
        // HEAD names the branch before it exists, so the checkout below is
        // one reset, and a clone of a repo whose default branch is not
        // git's own default lands on the right one.
        yield* git.run(partial, ["symbolic-ref", "HEAD", branchRef]);
        const { fetched } = yield* source.fetch({
          refs: [ref],
          haves: [],
          into: { path: partial },
          onProgress,
        });
        const tip = fetched.find((entry) => entry.ref === incomingRef)?.commit;
        if (tip === undefined) {
          return yield* new Git.GitRefusedError({
            reason: `${branch} did not arrive whole from the other device.`,
          });
        }
        yield* git.updateRef({ repo: partial, ref: branchRef, commit: tip });
        yield* git.deleteRef(partial, incomingRef);
        yield* git.run(partial, ["reset", "--quiet", "--hard"]);
        // The remote as `git clone` would leave it: origin, its HEAD on the
        // branch, the branch tracking it. The source answered the URL with
        // the clone payload's own rule (shared/cloneUrl.ts), re-checked
        // here before it reaches argv.
        if (remoteUrl !== null && isCloneableRemote(remoteUrl)) {
          yield* git.run(partial, ["remote", "add", "origin", remoteUrl]);
          yield* git.updateRef({
            repo: partial,
            ref: `refs/remotes/origin/${branch}`,
            commit: tip,
          });
          yield* git.run(partial, [
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            `refs/remotes/origin/${branch}`,
          ]);
          yield* git.run(partial, [
            "branch",
            "--set-upstream-to",
            `origin/${branch}`,
            "--end-of-options",
            branch,
          ]);
        }
      });
      // Says the clone is whole until its register: a retry that finds it
      // in the folder registers it rather than refusing the folder.
      yield* Effect.promise(() =>
        writeFile(
          join(partial, ".git", PENDING),
          Schema.encodeSync(Pending)({ dest, identity }),
        ),
      );
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          yield* Effect.tryPromise({
            try: () => rename(partial, dest),
            catch: (error) =>
              new Git.GitRefusedError({
                reason: `Couldn't put the clone at ${dest}: ${errnoWords(error, errorMessageOf(error))}.`,
              }),
          });
          return yield* finishRegister(dest, register);
        }),
      );
    }),
  );
});
