import { worktreeBase as worktreeBaseOf } from "@shigomori/contracts/git/worktreeLayout";
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
    // Where they would go under `proposed` layout settings.
    readonly baseFor: (
      project: ProjectPlace,
      proposed: {
        readonly worktreeLayout?: string | undefined;
        readonly customWorktreePath?: string | undefined;
      },
    ) => Effect.Effect<string>;
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
  const { home, dataDir, dataDirName } = yield* Paths.Paths;
  const place = {
    dataDir,
    dataDirReal: yield* fs
      .realPath(dataDir)
      .pipe(Effect.orElseSucceed(() => dataDir)),
    canonicalDataDirName: dataDirName,
  };

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

  const baseFor = Effect.fn("Layout.baseFor")(function* (
    project: ProjectPlace,
    settings: {
      readonly worktreeLayout?: string | undefined;
      readonly customWorktreePath?: string | undefined;
    },
  ) {
    return worktreeBaseOf({
      ...place,
      homedir: home,
      onProjectDrive: yield* config.device("managedOnProjectDrive"),
      layout: settings.worktreeLayout,
      projectPath: project.path,
      customPath: settings.customWorktreePath,
    });
  });

  const worktreeBase = Effect.fn("Layout.worktreeBase")(function* (
    project: ProjectPlace,
  ) {
    return yield* baseFor(project, yield* projectSettings(project));
  });

  const managedBases = Effect.fn("Layout.managedBases")(function* (
    project: ProjectPlace,
  ) {
    const { customWorktreePath } = yield* projectSettings(project);
    const bases = layout.managedBases(
      project.path,
      place,
      customWorktreePath,
      home,
    );
    const real = yield* Effect.forEach(bases, (base) =>
      fs.realPath(base).pipe(Effect.orElseSucceed(() => base)),
    );
    return [...new Set([...bases, ...real])];
  });

  return Layout.of({ worktreeBase, baseFor, managedBases });
});

export const layer = Layer.effect(Layout, make);
