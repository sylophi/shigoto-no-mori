// Worktrees' relocating: a project moved or renamed by hand, pointed at
// where it is now, its worktrees re-linked.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Git from "../Git.ts";
import type { WorktreeEntry } from "../gitParse.ts";
import * as Layout from "../Layout.ts";
import * as Paths from "../Paths.ts";
import * as Terrier from "../Terrier.ts";
import * as Registry from "../Registry.ts";
import type { RegisteredProject } from "../Registry.ts";
import { isManagedPath, worktreeIdFromPath } from "../worktreeLayout.ts";
import { RelocateRefused, type WorktreeIdentity } from "./documents.ts";
import type { ListingArea } from "./listing.ts";
import type { RemovingArea } from "./removing.ts";
import type { MovingArea } from "./moving.ts";

export const makeRelocating = ({
  listing,
  removing,
  moving,
}: {
  readonly listing: ListingArea;
  readonly removing: RemovingArea;
  readonly moving: MovingArea;
}) =>
  Effect.gen(function* () {
    const git = yield* Git.Git;
    const layout = yield* Layout.Layout;
    const registry = yield* Registry.Registry;
    const terrier = yield* Terrier.Terrier;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const paths = yield* Paths.Paths;
    const binary = paths.binaryName;
    const { identities } = listing;
    const { rekeyWorktree } = removing;
    const { move } = moving;

    // The linked worktrees that moved along with the repo: git lists them
    // at a path that is gone, and they sit at the same place relative to
    // the repo's new path. Inside the repo, or beside it when a parent
    // folder moved whole, each ancestor pair that still shares a name
    // tried, nearest first. Old path to new.
    const movedAlong = (repo: string, oldPath: string) =>
      Effect.gen(function* () {
        const moved = new Map<string, string>();
        const entries = yield* git
          .listWorktrees(repo)
          .pipe(Effect.orElseSucceed((): ReadonlyArray<WorktreeEntry> => []));
        const pairs: Array<readonly [string, string]> = [[oldPath, repo]];
        for (
          let from = oldPath, to = repo;
          path.basename(from) === path.basename(to);
        ) {
          from = path.dirname(from);
          to = path.dirname(to);
          if (from === to || from === path.dirname(from)) break;
          pairs.push([from, to]);
        }
        for (const entry of entries) {
          if (
            yield* fs.exists(entry.path).pipe(Effect.orElseSucceed(() => true))
          ) {
            continue;
          }
          for (const [from, to] of pairs) {
            if (!entry.path.startsWith(`${from}/`)) continue;
            const candidate = path.join(to, entry.path.slice(from.length + 1));
            const isDirectory = yield* fs.stat(candidate).pipe(
              Effect.map((info) => info.type === "Directory"),
              Effect.orElseSucceed(() => false),
            );
            if (isDirectory) {
              moved.set(entry.path, candidate);
              break;
            }
          }
        }
        return moved;
      });

    // `git worktree repair` for the moved ones, and what each kept under
    // its old id re-keyed. git repairs each path on its own, so the ones it
    // did re-link are re-keyed whatever it answers.
    const relinkMoved = (
      project: RegisteredProject,
      moved: ReadonlyMap<string, string>,
    ) =>
      Effect.gen(function* () {
        yield* git
          .run(project.path, ["worktree", "repair", "--", ...moved.values()])
          .pipe(Effect.ignore);
        const found = yield* identities(project).pipe(
          Effect.orElseSucceed((): ReadonlyArray<WorktreeIdentity> => []),
        );
        for (const [oldPath, newPath] of moved) {
          const resolved = yield* fs
            .realPath(newPath)
            .pipe(Effect.orElseSucceed(() => ""));
          const now = found.find(
            (id) =>
              id.path === newPath || (resolved !== "" && id.path === resolved),
          );
          if (now === undefined) continue;
          const from = worktreeIdFromPath(oldPath);
          if (from !== now.id) yield* rekeyWorktree(project, from, now.id);
        }
      });

    // The managed bases are named after the repo's folder, so a rename
    // would leave the managed worktrees reading as external. Each moves to
    // where new worktrees go.
    const rehomeManaged = (project: RegisteredProject, oldPath: string) =>
      Effect.gen(function* () {
        const oldBases = yield* layout.managedBases({
          ...project,
          path: oldPath,
        });
        const newBases = yield* layout.managedBases(project);
        const base = yield* layout.worktreeBase(project);
        const found = yield* identities(project).pipe(
          Effect.orElseSucceed((): ReadonlyArray<WorktreeIdentity> => []),
        );
        for (const worktree of found) {
          if (
            worktree.isPrimary ||
            !isManagedPath(worktree.path, oldBases) ||
            isManagedPath(worktree.path, newBases) ||
            !(yield* fs
              .exists(worktree.path)
              .pipe(Effect.orElseSucceed(() => false)))
          ) {
            continue;
          }
          yield* move(
            { project, worktree },
            path.join(base, path.basename(worktree.path)),
          ).pipe(Effect.ignore);
        }
      });

    const relocateProject = Effect.fn("Worktrees.relocateProject")(function* (
      project: Registry.ListedProject,
      target: string,
    ) {
      const refuse = (reason: RelocateRefused["reason"], at: string) =>
        new RelocateRefused({ reason, path: at, name: project.name, binary });
      if (project.source === "terrier") {
        return yield* refuse("via-terrier", project.path);
      }
      // Folded to the primary checkout, so a folder inside the repo or one
      // of its worktrees still lands on the repo.
      const repo = yield* git.locate(target);
      if (Option.isNone(repo)) return yield* refuse("not-a-repo", target);
      const to = repo.value.primaryPath;
      if (to !== project.path) {
        // Only for a repo that went: pointing a project that is still there
        // at another repo would hand that repo its settings and marks.
        const stillThere = yield* fs.stat(project.path).pipe(
          Effect.map((info) => info.type === "Directory"),
          Effect.orElseSucceed(() => false),
        );
        if (stillThere) return yield* refuse("still-there", project.path);
        // terrier's rows merge in by path, so either side being one would
        // list one repo twice.
        const { paths: listed } = yield* terrier.listing;
        if (listed.includes(project.path)) {
          return yield* refuse("terrier-lists-old", project.path);
        }
        if (listed.includes(to)) return yield* refuse("terrier-lists-new", to);
        const relocated = yield* registry.relocate(
          project.id,
          to,
          path.basename(to),
        );
        // Best effort from here: the entry already points at the new path.
        const moved = yield* movedAlong(to, project.path);
        moved.set(project.path, to);
        yield* relinkMoved(relocated, moved);
        yield* rehomeManaged(relocated, project.path);
      }
      const rows = yield* registry.rows();
      const found = rows.find((listed) => listed.id === project.id);
      if (!found)
        return yield* new Registry.UnknownProject({ projectId: project.id });
      return found;
    });

    return { relocateProject };
  });

export type RelocatingArea = Effect.Success<ReturnType<typeof makeRelocating>>;
