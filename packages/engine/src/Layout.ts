import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Config from "./Config.ts";
import * as layout from "./worktreeLayout.ts";
import * as Paths from "./Paths.ts";

const LAYOUTS = ["managed-root", "in-project", "custom"] as const;

// A registered project, as the layout needs it.
type ProjectPlace = { readonly id: string; readonly path: string };

export class Layout extends Context.Service<
  Layout,
  {
    // Where the project's new worktrees go.
    readonly worktreeBase: (project: ProjectPlace) => Effect.Effect<string>;
    // Every base whose direct children are the project's managed
    // worktrees, whatever its layout is now.
    readonly managedBases: (
      project: ProjectPlace,
    ) => Effect.Effect<ReadonlyArray<string>>;
  }
>()("sm/engine/Layout") {}

const make = Effect.gen(function* () {
  const config = yield* Config.Config;
  const { dataDir, dataDirName } = yield* Paths.Paths;
  const place = { dataDir, dataDirName };

  // The project's layout settings, which count only once the project is
  // configured (it has a default branch), and the device's drive setting.
  const settings = Effect.fn(function* (project: ProjectPlace) {
    const stored = yield* config.read({
      kind: "project",
      projectId: project.id,
    });
    const configured =
      typeof stored?.defaultBranch === "string" &&
      stored.defaultBranch.trim() !== "";
    const text = (value: unknown) =>
      configured && typeof value === "string" ? value : undefined;
    const onDrive = yield* config
      .get({ kind: "device" }, "managedOnProjectDrive")
      .pipe(Effect.orDie);
    const layoutName = text(stored?.worktreeLayout);
    return {
      worktreeLayout: LAYOUTS.find((name) => name === layoutName),
      customWorktreePath: text(stored?.customWorktreePath),
      managedOnProjectDrive: onDrive.value === true,
    };
  });

  const worktreeBase = Effect.fn("Layout.worktreeBase")(function* (
    project: ProjectPlace,
  ) {
    return layout.worktreeBase(project.path, yield* settings(project), place);
  });

  const managedBases = Effect.fn("Layout.managedBases")(function* (
    project: ProjectPlace,
  ) {
    return layout.managedBases(project.path, yield* settings(project), place);
  });

  return Layout.of({ worktreeBase, managedBases });
});

export const layer = Layer.effect(Layout, make);
