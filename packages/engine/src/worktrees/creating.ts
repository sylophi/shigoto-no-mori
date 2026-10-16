// Worktrees' creating: a new worktree's name and folder, its checkout,
// and the setup that runs in it (carry-over, the setup script, ports).
import { isValidWorktreeDirName } from "@shigomori/contracts/predicates/worktreeDirName";
import type { LifecycleSlot } from "@shigomori/contracts/schemas/scripts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { type AgentSession } from "../agentSessions.ts";
import * as CarryOver from "../CarryOver.ts";
import * as CloneCheckout from "../CloneCheckout.ts";
import type { CloneSource } from "../CloneCheckout.ts";
import { findExecutable } from "../executables.ts";
import * as Git from "../Git.ts";
import { splitRemoteRef } from "../gitParse.ts";
import * as Layout from "../Layout.ts";
import * as Lifecycle from "../Lifecycle.ts";
import { shellQuote } from "../Lifecycle.ts";
import { entryExists } from "../entries.ts";
import { pickWorktreeName } from "../names.ts";
import { parsePortPoolConfig, PORT_POOL_CONFIG } from "../ports.ts";
import * as Registry from "../Registry.ts";
import type { RegisteredProject } from "../Registry.ts";
import {
  type Cloned,
  type Reporter,
  type WorktreeIdentity,
  WorktreeRefused,
  isPrimaryKeyword,
  namesUsed,
  scriptOf,
} from "./documents.ts";
import type { ListingArea } from "./listing.ts";
import type { KeptArea } from "./kept.ts";
import type { StatusCardArea } from "./statusCard.ts";

const checkName = (name: string) =>
  isPrimaryKeyword(name)
    ? Effect.fail(
        new WorktreeRefused({ reason: "reserved-name", subject: name }),
      )
    : name !== "" && !isValidWorktreeDirName(name)
      ? Effect.fail(
          new WorktreeRefused({ reason: "invalid-name", subject: name }),
        )
      : Effect.void;

export const makeCreating = ({
  listing,
  statusCard,
  kept,
}: {
  readonly listing: ListingArea;
  readonly statusCard: StatusCardArea;
  readonly kept: KeptArea;
}) =>
  Effect.gen(function* () {
    const git = yield* Git.Git;
    const sql = yield* SqlClient.SqlClient;
    const lifecycle = yield* Lifecycle.Lifecycle;
    const carryOver = yield* CarryOver.CarryOver;
    const cloneCheckout = yield* CloneCheckout.CloneCheckout;
    const layout = yield* Layout.Layout;
    const registry = yield* Registry.Registry;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const {
      deviceFlag,
      projectSettings,
      identities,
      primaryRefOf,
      descriptionOf,
      row,
    } = listing;
    const { readOptional } = statusCard;
    // A fresh folder name. It doubles as the branch name, so names a kept
    // local branch holds (a removed worktree's) are skipped too.
    const pickName = (project: RegisteredProject, used: ReadonlySet<string>) =>
      Effect.gen(function* () {
        const taken = new Set(used);
        const refs = yield* git.branchRefs(project.path).pipe(Effect.option);
        for (const branch of Option.match(refs, {
          onNone: () => [],
          onSome: ({ locals }) => locals,
        })) {
          taken.add(branch.toLowerCase());
        }
        return yield* pickWorktreeName(
          taken,
          yield* deviceFlag("doubutsuNames"),
        );
      });

    const occupied = (file: string) => entryExists(fs, file);

    // Refused while a move under way names the path: what is kept under
    // its id, a capture among it, is that move's until it ends.
    const unreserved = (place: string) =>
      Effect.gen(function* () {
        const [moving] = yield* sql<{ from_path: string }>`
          SELECT from_path FROM moving
          WHERE from_path = ${place} OR to_path = ${place}`.pipe(Effect.orDie);
        if (moving !== undefined) {
          return yield* new WorktreeRefused({
            reason: "move-in-progress",
            subject: moving.from_path,
          });
        }
      });

    const destination = Effect.fn("Worktrees.destination")(function* (
      project: RegisteredProject,
      requested: string,
    ) {
      const name = requested.trim();
      yield* checkName(name);
      const used = namesUsed(yield* identities(project));
      const picked = name === "" ? yield* pickName(project, used) : name;
      const place = path.join(yield* layout.worktreeBase(project), picked);
      const taken =
        (name !== "" && used.has(name.toLowerCase())) ||
        (yield* occupied(place));
      return { name: picked, path: place, taken };
    });

    // What a script is told about the worktree it runs in.
    // `found` is the project's checkouts, when the caller has them.
    const scriptContext = (
      project: RegisteredProject,
      worktree: WorktreeIdentity,
      found?: ReadonlyArray<WorktreeIdentity>,
    ) =>
      Effect.gen(function* () {
        const [listed, primary, described] = yield* Effect.all(
          [
            found === undefined
              ? identities(project).pipe(
                  Effect.orElseSucceed(
                    (): ReadonlyArray<WorktreeIdentity> => [],
                  ),
                )
              : Effect.succeed(found),
            primaryRefOf(project),
            descriptionOf(worktree),
          ],
          { concurrency: "unbounded" },
        );
        return {
          project,
          worktree,
          projectBranch: listed.find((id) => id.isPrimary)?.branch ?? "",
          defaultBranch: primary.primaryRef,
          title: described.title,
          description: described.description,
        };
      });

    const runScript = (
      context: Lifecycle.ScriptContext,
      reporter: Reporter,
      command: string,
      slot: LifecycleSlot,
    ) =>
      lifecycle.run({
        command,
        slot,
        context,
        color: reporter.color,
        report: reporter.report,
      });

    // Whether port-pool provisions and releases this worktree: the device
    // setting is on, port-pool is installed, the worktree is configured for
    // it, and the app made the worktree (no provision ever ran for an
    // external one, so none is released either).
    const portPoolActive = (worktree: WorktreeIdentity) =>
      Effect.gen(function* () {
        if (worktree.isExternal || !(yield* deviceFlag("portPool")))
          return false;
        const installed = yield* findExecutable("port-pool").pipe(
          Effect.map(Option.isSome),
          Effect.provideContext(platform),
        );
        return (
          installed &&
          parsePortPoolConfig(
            yield* readOptional(path.join(worktree.path, PORT_POOL_CONFIG)),
          ).configured
        );
      });

    // The setup script, then port-pool's provision (never for an external
    // worktree, whose release never runs). Answers the failures and the
    // steps that ran. The caller reports the closing idle phase.
    const provision = (
      project: RegisteredProject,
      worktree: WorktreeIdentity,
      settings: Readonly<Record<string, unknown>> | null,
      skipSetup: boolean,
      reporter: Reporter,
      found?: ReadonlyArray<WorktreeIdentity>,
    ) =>
      Effect.gen(function* () {
        const failures: Lifecycle.ScriptFailure[] = [];
        const ran: string[] = [];
        const setup = skipSetup ? "" : scriptOf(settings, "setup");
        const pool = yield* portPoolActive(worktree);
        if (setup === "" && !pool) return { failures, ran };
        const context = yield* scriptContext(project, worktree, found);
        const step = (
          name: string,
          phase: Lifecycle.Phase,
          command: string,
          slot: LifecycleSlot,
        ) =>
          Effect.gen(function* () {
            yield* reporter.report({ event: "phase", phase });
            ran.push(name);
            const { code } = yield* runScript(context, reporter, command, slot);
            if (code !== 0) failures.push({ step: name, exitCode: code });
          });
        if (setup !== "")
          yield* step("setup", "setup", setup, { kind: "setup" });
        if (pool) {
          yield* step(
            "port-pool provision",
            "portPoolProvision",
            `port-pool provision ${shellQuote(worktree.path)}`,
            { kind: "portPool", phase: "provision" },
          );
        }
        return { failures, ran };
      });

    // What a new worktree goes through: carry-over, then the setup script
    // and port-pool's provision. `base` is the ref it was branched from,
    // which decides where carry-over looks first.
    const createLifecycle = (
      project: RegisteredProject,
      worktree: WorktreeIdentity,
      checkouts: ReadonlyArray<WorktreeIdentity>,
      base: string,
      skipSetup: boolean,
      reporter: Reporter,
    ) =>
      Effect.gen(function* () {
        const { settings } = yield* projectSettings(project);
        const carried = yield* carryOver.apply({
          repo: project.path,
          settings,
          checkouts,
          destination: worktree.path,
          base,
        });
        if (Option.isSome(carried)) {
          yield* reporter.report({ event: "phase", phase: "carryOver" });
          yield* reporter.report({ event: "carryOver", report: carried.value });
        }
        const { failures } = yield* provision(
          project,
          worktree,
          settings,
          skipSetup,
          reporter,
          checkouts,
        );
        yield* reporter.report({ event: "phase", phase: "idle" });
        return failures;
      });

    // The one way a worktree is made: the name checked or picked, the
    // layout's place, the base's remote ref refreshed, `git worktree add`,
    // and the identity git settled on. `checkout` puts the existing branch
    // `base` there (adopt's way) instead of making a new one. `clone`
    // clones the tracked files from an existing checkout where it can,
    // instead of having git write them all.
    const addWorktree = (
      project: RegisteredProject,
      input: {
        readonly name: string;
        readonly branch: string;
        readonly base: string;
        readonly checkout: boolean;
        readonly clone: boolean;
      },
    ) =>
      Effect.gen(function* () {
        if (input.checkout && input.base === "") {
          return yield* new WorktreeRefused({
            reason: "checkout-needs-base",
            subject: "",
          });
        }
        const existing = yield* identities(project);
        const used = namesUsed(existing);
        if (input.name !== "" && used.has(input.name.toLowerCase())) {
          return yield* new WorktreeRefused({
            reason: "name-taken",
            subject: input.name,
          });
        }
        const name =
          input.name === "" ? yield* pickName(project, used) : input.name;
        const place = path.join(yield* layout.worktreeBase(project), name);
        // The remote-tracking ref the worktree sits on, refreshed, so the
        // base isn't whatever the last fetch left.
        let remotes: ReadonlyArray<string> | undefined;
        if (
          input.base !== "" &&
          (yield* git.remoteRefExists(project.path, input.base))
        ) {
          remotes = yield* git.listRemotes(project.path);
          const split = splitRemoteRef(input.base, remotes);
          if (split) {
            yield* git
              .run(project.path, [
                "fetch",
                "--quiet",
                split.remote,
                split.branch,
              ])
              .pipe(Effect.ignore);
          }
        }
        // Projects that share a folder name share a base, so a sibling's
        // worktree can sit at the path.
        if (yield* occupied(place)) {
          return yield* new WorktreeRefused({
            reason: "destination-taken",
            subject: place,
          });
        }
        yield* unreserved(place);
        yield* fs
          .makeDirectory(path.dirname(place), { recursive: true })
          .pipe(Effect.orDie);
        // The checkout on the base branch, else the primary, else another:
        // where carry-over looks too.
        const source = input.clone
          ? yield* cloneCheckout.pickSource({
              repo: project.path,
              checkouts: existing,
              destination: place,
              baseBranch:
                input.base === ""
                  ? ""
                  : (yield* git.resolveCheckoutRef(
                      project.path,
                      input.base,
                      remotes,
                    )).target,
            })
          : Option.none<CloneSource>();
        const noCheckout = Option.isSome(source);
        // The branch the add makes: a new one, or in checkout mode the local
        // branch it tracks a remote base with.
        const branch = input.checkout
          ? Option.getOrElse(
              (yield* git.resolveCheckoutRef(project.path, input.base, remotes))
                .track,
              () => "",
            )
          : input.branch.trim() === ""
            ? name
            : input.branch.trim();
        if (input.checkout) {
          yield* git.checkoutWorktree({
            repo: project.path,
            path: place,
            ref: input.base,
            remotes,
            noCheckout,
          });
        } else {
          yield* git.addWorktree({
            repo: project.path,
            path: place,
            branch,
            base: input.base === "" ? undefined : input.base,
            noCheckout,
          });
        }
        let cloned: Cloned | undefined;
        if (Option.isSome(source)) {
          // Nothing checked out (the clone and git's own checkout both
          // failed, or the run was interrupted midway): the add goes again,
          // and the branch it made, as git undoes its own failed checkout. A
          // failed hook leaves the worktree, as git leaves it.
          const undo = git
            .run(project.path, ["worktree", "remove", "--force", place])
            .pipe(
              Effect.andThen(
                branch === ""
                  ? Effect.void
                  : git.run(project.path, ["branch", "-D", branch]),
              ),
              Effect.ignore,
            );
          const outcome = yield* cloneCheckout
            .finish({ source: source.value.path, worktree: place })
            .pipe(
              Effect.onExit((exit) =>
                Exit.isFailure(exit) &&
                (Cause.hasInterrupts(exit.cause) ||
                  Cause.hasDies(exit.cause) ||
                  Option.exists(
                    Cause.findErrorOption(exit.cause),
                    (error) =>
                      error instanceof CloneCheckout.CheckoutUnfinished,
                  ))
                  ? undo
                  : Effect.void,
              ),
            );
          cloned = { from: source.value, outcome };
        }
        const found = yield* identities(project);
        const made = found.find((id) => id.path === place);
        if (!made) {
          return yield* new WorktreeRefused({
            reason: "vanished",
            subject: place,
          });
        }
        // The id is the path's, so what a worktree removed from here left
        // under it (a removal a crash cut short) isn't this one's.
        yield* kept.forget(project, made.id);
        return { made, found, cloned };
      });

    const create = Effect.fn("Worktrees.create")(function* (
      project: RegisteredProject,
      input: {
        readonly name?: string | undefined;
        readonly branch?: string | undefined;
        readonly base?: string | undefined;
        readonly checkout?: boolean | undefined;
        readonly skipSetup?: boolean | undefined;
        readonly agentSession?:
          | Pick<AgentSession, "harness" | "session" | "state">
          | undefined;
        readonly clone?: boolean | undefined;
      },
      reporter: Reporter,
    ) {
      const name = input.name ?? "";
      yield* checkName(name);
      // A ref git would read as an option.
      for (const [reason, ref] of [
        ["invalid-branch", input.branch],
        ["invalid-base", input.base],
      ] as const) {
        if (ref?.startsWith("-")) {
          return yield* new WorktreeRefused({ reason, subject: ref });
        }
      }
      const { made, found, cloned } = yield* addWorktree(project, {
        name,
        branch: input.branch ?? "",
        base: input.base ?? "",
        checkout: input.checkout ?? false,
        clone: input.clone ?? true,
      });
      // Only a worktree that is new takes the autoPullNew setting's mark.
      const [autoPullNew, primaryOnly] = yield* Effect.all([
        deviceFlag("autoPullNew"),
        deviceFlag("autoPullPrimaryOnly"),
      ]);
      if (autoPullNew && !primaryOnly) {
        yield* registry.setMark("autoPull", made.id, true);
      }
      if (input.agentSession !== undefined) {
        yield* registry.bindAgentSession(input.agentSession, made.id);
      }
      const worktree = yield* row({ project, worktree: made });
      if (cloned !== undefined)
        yield* reporter.report({ event: "cloned", cloned });
      yield* reporter.report({ event: "created", worktree });
      const failures = yield* createLifecycle(
        project,
        made,
        found,
        input.base ?? "",
        input.skipSetup ?? false,
        reporter,
      );
      return { worktree, failures };
    });
    return {
      checkName,
      occupied,
      unreserved,
      destination,
      scriptContext,
      runScript,
      portPoolActive,
      provision,
      createLifecycle,
      addWorktree,
      create,
    };
  });

export type CreatingArea = Effect.Success<ReturnType<typeof makeCreating>>;
