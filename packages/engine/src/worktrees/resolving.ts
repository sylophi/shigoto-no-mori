// Worktrees' resolving: the worktree or project a command means, from
// where it runs, a name, a path or an id.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Git from "../Git.ts";
import * as Paths from "../Paths.ts";
import * as Registry from "../Registry.ts";
import type { RegisteredProject } from "../Registry.ts";
import {
  type Here,
  type Located,
  type Target,
  TargetError,
  UnknownWorktree,
  isPrimaryKeyword,
  looksLikePath,
} from "./documents.ts";
import type { ListingArea } from "./listing.ts";

export const makeResolving = ({ listing }: { readonly listing: ListingArea }) =>
  Effect.gen(function* () {
    const git = yield* Git.Git;
    const registry = yield* Registry.Registry;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const paths = yield* Paths.Paths;
    const binary = paths.binaryName;
    const { identities } = listing;
    const targetError = (
      here: Here,
      reason: TargetError["reason"],
      ref = "",
      matches: ReadonlyArray<string> = [],
    ) =>
      new TargetError({
        reason,
        ref,
        matches: [...matches],
        projects: here.projects.map((project) => project.name),
        binary,
      });

    // The worktree at `toplevel` among the projects whose primary is
    // `primaryPath`. `owned` tells "not a registered repo" from
    // "registered, but its worktrees unreadable".
    const worktreeAt = (
      projects: ReadonlyArray<RegisteredProject>,
      toplevel: string,
      primaryPath: string,
    ) =>
      Effect.gen(function* () {
        let owned = false;
        for (const project of projects) {
          if (project.path !== primaryPath) continue;
          owned = true;
          const found = yield* identities(project).pipe(Effect.option);
          if (Option.isNone(found)) continue;
          const worktree = found.value.find((id) => id.path === toplevel);
          if (worktree) return { located: { project, worktree }, owned };
        }
        return { located: undefined, owned };
      });

    const locate = Effect.fn("Worktrees.here")(function* (cwd: string) {
      const projects = yield* registry.listed;
      const repo = yield* git.locate(cwd);
      if (Option.isNone(repo)) {
        return {
          cwd,
          projects,
          current: undefined,
          unregisteredRepo: undefined,
        };
      }
      const { located, owned } = yield* worktreeAt(
        projects,
        repo.value.toplevel,
        repo.value.primaryPath,
      );
      return {
        cwd,
        projects,
        current: located,
        unregisteredRepo: located || owned ? undefined : repo.value.toplevel,
      };
    });

    // A typed path made absolute against the command's cwd, ~ expanded.
    const absolute = (here: Here, ref: string) =>
      path.resolve(here.cwd, paths.expandHome(ref));

    const resolveProject = Effect.fn("Worktrees.resolveProject")(function* (
      here: Here,
      ref: string | undefined,
    ) {
      if (ref === undefined || ref === "") {
        if (here.current) return here.current.project;
        return yield* here.unregisteredRepo !== undefined
          ? targetError(here, "unregistered-project", here.unregisteredRepo)
          : targetError(here, "not-in-project");
      }
      // A path resolves against the registered paths, which are unique
      // where names are not: by string first, so an entry whose folder is
      // gone stays addressable, then by the repository it is inside.
      if (looksLikePath(ref)) {
        const abs = absolute(here, ref);
        const exact = here.projects.find((project) => project.path === abs);
        if (exact) return exact;
        const repo = yield* git.locate(abs);
        const owner = Option.flatMapNullishOr(repo, ({ primaryPath }) =>
          here.projects.find((project) => project.path === primaryPath),
        );
        if (Option.isSome(owner)) return owner.value;
        return yield* targetError(here, "no-project-at", abs);
      }
      const named = here.projects.filter(
        (project) => project.name.toLowerCase() === ref.toLowerCase(),
      );
      if (named.length === 1) return named[0] as Registry.ListedProject;
      if (named.length > 1) {
        // Never guess: the path is how to say which.
        return yield* targetError(
          here,
          "ambiguous-project",
          ref,
          named.map((project) => project.path),
        );
      }
      // The id the app names it by works too. Names win.
      const byId = here.projects.find((project) => project.id === ref);
      if (byId) return byId;
      return yield* targetError(here, "unknown-project", ref);
    });

    const resolveProjectById = Effect.fn("Worktrees.resolveProjectById")(
      function* (here: Here, projectId: string) {
        const found = here.projects.find((project) => project.id === projectId);
        if (!found) return yield* new Registry.UnknownProject({ projectId });
        return found;
      },
    );

    const resolveProjectRef = (
      here: Here,
      ref: Pick<Target, "project" | "projectId">,
    ) =>
      ref.projectId !== undefined && ref.projectId !== ""
        ? resolveProjectById(here, ref.projectId)
        : resolveProject(here, ref.project);

    const primaryOf = Effect.fn(function* (
      here: Here,
      project: RegisteredProject,
    ) {
      const worktree = (yield* identities(project)).find((id) => id.isPrimary);
      if (!worktree)
        return yield* targetError(here, "no-primary", project.name);
      return { project, worktree };
    });

    const resolve = Effect.fn("Worktrees.resolve")(function* (
      here: Here,
      target: Target,
    ) {
      if (target.worktreeId) {
        const scope = target.projectId
          ? [yield* resolveProjectById(here, target.projectId)]
          : here.projects;
        // In order, stopping at the first: the app asks this on every
        // per-worktree call.
        for (const project of scope) {
          const listed = yield* identities(project).pipe(Effect.option);
          const worktree = Option.getOrUndefined(listed)?.find(
            (id) => id.id === target.worktreeId,
          );
          if (worktree) return { project, worktree };
        }
        return yield* new UnknownWorktree({ worktreeId: target.worktreeId });
      }

      const ref = target.ref ?? "";
      if (ref === "") {
        // -p with no name targets that project, never whatever project
        // the cwd is in. A cwd inside the named project keeps its default.
        if (target.project) {
          const project = yield* resolveProject(here, target.project);
          if (here.current?.project.id !== project.id) {
            return yield* targetError(here, "name-in-project", project.name);
          }
        }
        if (here.current) return here.current;
        return yield* here.unregisteredRepo !== undefined
          ? targetError(here, "unregistered-worktree", here.unregisteredRepo)
          : targetError(here, "not-in-worktree");
      }

      // A ref that is a directory resolves by identity, not name, so
      // externals with colliding basenames stay addressable (`sm rm .`).
      if (looksLikePath(ref)) {
        const abs = absolute(here, ref);
        const isDirectory = yield* fs.stat(abs).pipe(
          Effect.map((info) => info.type === "Directory"),
          Effect.orElseSucceed(() => false),
        );
        if (isDirectory) {
          const repo = yield* git.locate(abs);
          if (Option.isSome(repo)) {
            const { located } = yield* worktreeAt(
              here.projects,
              repo.value.toplevel,
              repo.value.primaryPath,
            );
            if (located) return located;
          }
          return yield* targetError(here, "not-a-worktree", abs);
        }
      }

      let scope = here.projects;
      let name = ref;
      if (target.project) {
        scope = [yield* resolveProject(here, target.project)];
      } else if (ref.includes("/")) {
        const cut = ref.indexOf("/");
        scope = [yield* resolveProject(here, ref.slice(0, cut))];
        name = ref.slice(cut + 1);
      }

      // The reserved names beat the name scan: a narrowed scope answers
      // directly, an unqualified one prefers the project at the cwd.
      if (isPrimaryKeyword(name)) {
        if (scope.length === 1)
          return yield* primaryOf(here, scope[0] as RegisteredProject);
        if (here.current) return yield* primaryOf(here, here.current.project);
        if (scope.length > 1) {
          return yield* targetError(here, "keyword-needs-project", name);
        }
      }

      const matches = (yield* Effect.forEach(
        scope,
        (project) =>
          identities(project).pipe(
            Effect.map((found) =>
              found
                .filter((id) => id.name.toLowerCase() === name.toLowerCase())
                .map((worktree) => ({ project, worktree })),
            ),
            // A missing or broken repo: the others can still match.
            Effect.orElseSucceed((): Located[] => []),
          ),
        { concurrency: "unbounded" },
      )).flat();
      if (matches.length === 1) return matches[0] as Located;
      if (matches.length === 0) {
        return yield* targetError(
          here,
          "no-such-worktree",
          name,
          scope.length === 1 ? [(scope[0] as RegisteredProject).name] : [],
        );
      }
      return yield* targetError(
        here,
        "ambiguous-worktree",
        name,
        matches.map(
          ({ project, worktree }) => `${project.name}/${worktree.name}`,
        ),
      );
    });

    return {
      locate,
      resolveProject,
      resolveProjectById,
      resolveProjectRef,
      resolve,
    };
  });
