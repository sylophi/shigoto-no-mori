import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Config from "./Config.ts";
import * as layout from "./worktreeLayout.ts";
import * as Paths from "./Paths.ts";

// A registered project, as the layout needs it.
type ProjectPlace = { readonly id: string; readonly path: string };

export class Layout extends Context.Service<
  Layout,
  {
    // Where the project's new worktrees go.
    readonly worktreeBase: (project: ProjectPlace) => Effect.Effect<string>;
    // Every base whose direct children are the project's managed
    // worktrees, whatever its layout is now, each also as git spells it
    // (its symlinks resolved).
    readonly managedBases: (
      project: ProjectPlace,
    ) => Effect.Effect<ReadonlyArray<string>>;
  }
>()("sm/engine/Layout") {}

const make = Effect.gen(function* () {
  const config = yield* Config.Config;
  const fs = yield* FileSystem.FileSystem;
  const { dataDir, dataDirName } = yield* Paths.Paths;
  const place = { dataDir, dataDirName };

  // The project's layout settings, which count only once the project is
  // configured (it has a default branch).
  const projectSettings = Effect.fn(function* (project: ProjectPlace) {
    const stored = yield* config.read({
      kind: "project",
      projectId: project.id,
      path: project.path,
    });
    const configured =
      typeof stored?.defaultBranch === "string" &&
      stored.defaultBranch.trim() !== "";
    const text = (value: unknown) =>
      configured && typeof value === "string" ? value : undefined;
    return {
      worktreeLayout: text(stored?.worktreeLayout),
      customWorktreePath: text(stored?.customWorktreePath),
    };
  });

  const worktreeBase = Effect.fn("Layout.worktreeBase")(function* (
    project: ProjectPlace,
  ) {
    const settings = yield* projectSettings(project);
    // The device's drive setting matters only for a managed root a
    // project's own drive could hold.
    const onDrive =
      (settings.worktreeLayout ?? "managed-root") === "managed-root" &&
      layout.projectDriveBase(project.path, place) !== undefined
        ? (yield* config
            .get({ kind: "device" }, "managedOnProjectDrive")
            .pipe(Effect.orDie)).value === true
        : false;
    return layout.worktreeBase(
      project.path,
      { ...settings, managedOnProjectDrive: onDrive },
      place,
    );
  });

  const managedBases = Effect.fn("Layout.managedBases")(function* (
    project: ProjectPlace,
  ) {
    const bases = layout.managedBases(
      project.path,
      yield* projectSettings(project),
      place,
    );
    const real = yield* Effect.forEach(bases, (base) =>
      fs.realPath(base).pipe(Effect.orElseSucceed(() => base)),
    );
    return [...new Set([...bases, ...real])];
  });

  return Layout.of({ worktreeBase, managedBases });
});

export const layer = Layer.effect(Layout, make);
