import type { LauncherEntry } from "@shigomori/contracts/schemas/launchers";
import { findExecutable } from "./executables.ts";
import { byPlatform } from "./platform.ts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import catalog from "./data/launcher-catalog.json" with { type: "json" };
import * as EngineConfig from "./Config.ts";
import * as Paths from "./Paths.ts";
import * as Usage from "./Usage.ts";

// One app the launcher row knows, as the catalog lists it: found by its
// bundle name in a Mac's app folders, by its program on PATH on Windows
// (either one FILE_MANAGER, the desktop's own), or by its command line
// tool on PATH. A deep link with {path} opens it, and
// openArgs are the launch arguments of one that takes the folder that
// way. A terminal tool is the command line inTerminal runs in the
// user's terminal, found by its first word on PATH. editor marks the
// tools the editor setting can name, which open a file (Open.edit).
export type CatalogApp = {
  readonly id: string;
  readonly label: string;
  readonly bundleNames?: ReadonlyArray<string>;
  readonly programs?: ReadonlyArray<string>;
  readonly cli?: string;
  readonly deepLink?: string;
  readonly openArgs?: ReadonlyArray<string>;
  readonly inTerminal?: string;
  readonly editor?: boolean;
};

export type CatalogEntry = {
  readonly kind: "detected";
  readonly id: string;
  readonly label: string;
  readonly available: boolean;
  readonly editor?: true;
};

// One launcher on a project's row: an installed app or a custom command
// (the device's, then the project's). A detected app is installed by
// being listed.
export type RowEntry = LauncherEntry;

// A launcher with what launching it takes: an installed app with the
// bundle or tool it was found by, or a custom command line.
export type Launchable =
  | (RowEntry & {
      readonly kind: "detected";
      readonly app: CatalogApp;
      // The first bundle or program found (FILE_MANAGER for the
      // desktop's), if any.
      readonly bundle: string | undefined;
      readonly cliOnPath: boolean;
    })
  | (RowEntry & { readonly kind: "custom"; readonly command: string });

export type LauncherRow = {
  // By uses in the last two weeks, then by label. Hidden ones left out.
  readonly entries: ReadonlyArray<RowEntry>;
  readonly hiddenCount: number;
  readonly usage: Readonly<Record<string, Usage.UseStat>>;
};

export class Launchers extends Context.Service<
  Launchers,
  {
    // Every app the catalog knows, installed or not, by label.
    readonly catalog: Effect.Effect<ReadonlyArray<CatalogEntry>>;
    // The launchers `sm open` offers for a project.
    readonly row: (project: {
      readonly id: string;
      readonly path: string;
    }) => Effect.Effect<LauncherRow>;
    // Every launcher the project has, hidden ones included, in the row's
    // order of assembly: installed apps, the device's custom commands,
    // then the project's.
    readonly launchable: (project: {
      readonly id: string;
      readonly path: string;
    }) => Effect.Effect<ReadonlyArray<Launchable>>;
    // The catalog's app `id`, when it is installed here.
    readonly installed: (id: string) => Effect.Effect<CatalogApp | undefined>;
  }
>()("sm/engine/Launchers") {}

// A JSON field read as a string: absent, null or text.
const text = (value: unknown) =>
  value === undefined || value === null || typeof value === "string";

// A settings document's custom launchers, each field as stored, and its
// hidden ids: a missing field reads as empty, and a document holding
// one of the wrong type reads as the defaults (none of either).
export const decodedLaunchers = (
  doc: Readonly<Record<string, unknown>> | null,
): {
  readonly custom: ReadonlyArray<{
    readonly id?: string | null;
    readonly label?: string | null;
    readonly command?: string | null;
  }>;
  readonly hidden: ReadonlyArray<string>;
} => {
  const none = { custom: [], hidden: [] };
  const { launchers = null, hiddenLaunchers = null } = doc ?? {};
  if (launchers !== null && !Array.isArray(launchers)) return none;
  if (hiddenLaunchers !== null && !Array.isArray(hiddenLaunchers)) return none;
  const entries = (launchers ?? []) as ReadonlyArray<unknown>;
  const hidden = (hiddenLaunchers ?? []) as ReadonlyArray<unknown>;
  const wellTyped =
    entries.every(
      (entry) =>
        entry === null ||
        (Predicate.isObject(entry) &&
          ["id", "label", "command"].every((field) => text(entry[field]))),
    ) && hidden.every((id) => typeof id === "string");
  if (!wellTyped) return none;
  return {
    custom: entries.map(
      (entry) =>
        (entry ?? {}) as {
          id?: string | null;
          label?: string | null;
          command?: string | null;
        },
    ),
    hidden: hidden as ReadonlyArray<string>,
  };
};

const launchersOf = (
  doc: Readonly<Record<string, unknown>> | null,
): {
  readonly custom: ReadonlyArray<RowEntry>;
  readonly hidden: ReadonlyArray<string>;
} => {
  const { custom, hidden } = decodedLaunchers(doc);
  return {
    custom: custom.map(({ id, label }) => ({
      kind: "custom" as const,
      id: `custom:${id ?? ""}`,
      label: label ?? "",
    })),
    hidden,
  };
};

// Where an installed .app can live, in the order they are looked in.
// Linux and Windows have none: their launchers are found on PATH.
export const appFoldersOf = (path: Path.Path, home: string) =>
  byPlatform({
    darwin: [
      "/Applications",
      path.join(home, "Applications"),
      "/System/Applications",
    ],
    linux: [],
    win32: [],
  });

// The desktop's file manager, always there where the OS has one, which
// opens a folder as the desktop does (Open).
export const FILE_MANAGER = "__file_manager__";

const catalogApps: ReadonlyArray<CatalogApp> = catalog;

// Where an app is looked for on this OS.
const placesOf = (app: CatalogApp) =>
  byPlatform({
    darwin: app.bundleNames,
    linux: app.bundleNames,
    win32: app.programs,
  }) ?? [];

// Code-unit order, as Go compares strings.
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { home } = yield* Paths.Paths;
  const settings = yield* EngineConfig.Config;
  const usage = yield* Usage.Usage;
  const appFolders = appFoldersOf(path, home);
  const fileManager = byPlatform({ darwin: true, linux: false, win32: true });
  // The provider the engine was built with, not the caller's: a fiber
  // with none set reads a copy of the environment taken once.
  const configProvider = yield* ConfigProvider.ConfigProvider;

  const exists = (file: string) =>
    fs.exists(file).pipe(Effect.orElseSucceed(() => false));

  // Where `name` is on PATH. Read on each ask, since the host outlives
  // a tool's install.
  const pathTo = (name: string) =>
    findExecutable(name).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, configProvider),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  const onPath = (name: string) => Effect.map(pathTo(name), Option.isSome);

  const inAppFolders = Effect.fnUntraced(function* (bundle: string) {
    for (const folder of appFolders) {
      const found = path.join(folder, bundle);
      if (yield* exists(found)) return found;
    }
    return undefined;
  });

  const foundAt = byPlatform({
    darwin: inAppFolders,
    linux: inAppFolders,
    win32: (name: string) => Effect.map(pathTo(name), Option.getOrUndefined),
  });

  // The catalog's apps this OS can have: those with a place to look for
  // them here, a command line tool or a terminal tool.
  const apps = catalogApps.filter(
    (app) =>
      placesOf(app).length > 0 ||
      app.cli !== undefined ||
      app.inTerminal !== undefined,
  );

  // The bundle or program an app was found by, in its own order.
  const bundleOf = (app: CatalogApp) =>
    Effect.gen(function* () {
      for (const place of placesOf(app)) {
        if (place === FILE_MANAGER) return fileManager ? place : undefined;
        const found = yield* foundAt(place);
        if (found !== undefined) return found;
      }
      return undefined;
    });

  const toolOnPath = (app: CatalogApp) => {
    const tool = app.inTerminal?.trim().split(/\s+/)[0];
    return tool === undefined ? Effect.succeed(false) : onPath(tool);
  };

  // What an installed app was found by.
  const foundBy = (app: CatalogApp) =>
    Effect.gen(function* () {
      const bundle = yield* bundleOf(app);
      const cliOnPath = app.cli !== undefined && (yield* onPath(app.cli));
      return bundle !== undefined || cliOnPath || (yield* toolOnPath(app))
        ? { app, bundle, cliOnPath }
        : undefined;
    });

  const available = (app: CatalogApp) =>
    Effect.map(foundBy(app), (found) => found !== undefined);

  const listCatalog = Effect.forEach(
    apps,
    (app) =>
      Effect.map(available(app), (installed): CatalogEntry => ({
        kind: "detected",
        id: `app:${app.id}`,
        label: app.label,
        available: installed,
        ...(app.editor === true ? { editor: true as const } : {}),
      })),
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map((entries) =>
      entries.toSorted(
        (a, b) =>
          compare(a.label.toLowerCase(), b.label.toLowerCase()) ||
          compare(b.label, a.label),
      ),
    ),
    Effect.withSpan("Launchers.catalog"),
  );

  const row = Effect.fn("Launchers.row")(function* (project: {
    readonly id: string;
    readonly path: string;
  }) {
    const [device, stored, installed, stats] = yield* Effect.all(
      [
        settings.read({ kind: "device" }),
        settings.read({
          kind: "project",
          projectId: project.id,
          path: project.path,
        }),
        Effect.filter(apps, available, { concurrency: "unbounded" }),
        usage.stats("launcher", ""),
      ],
      { concurrency: "unbounded" },
    );
    const deviceLaunchers = launchersOf(device);
    // A project's own launchers count once it is configured.
    const configured =
      typeof stored?.defaultBranch === "string" &&
      stored.defaultBranch.trim() !== "";
    const all: ReadonlyArray<RowEntry> = [
      ...installed.map((app) => ({
        kind: "detected" as const,
        id: `app:${app.id}`,
        label: app.label,
        available: true as const,
      })),
      ...deviceLaunchers.custom,
      ...(configured ? launchersOf(stored).custom : []),
    ];
    const hidden = new Set(deviceLaunchers.hidden);
    const statOf = (id: string) =>
      stats.get(id) ?? { lastUsed: 0, recentCount: 0 };
    const shown = all
      .filter(({ id }) => !hidden.has(id))
      .toSorted(
        (a, b) =>
          statOf(b.id).recentCount - statOf(a.id).recentCount ||
          compare(a.label.toLowerCase(), b.label.toLowerCase()),
      );
    return {
      entries: shown,
      hiddenCount: all.length - shown.length,
      usage: Object.fromEntries(shown.map(({ id }) => [id, statOf(id)])),
    };
  });

  const launchable = Effect.fn("Launchers.launchable")(function* (project: {
    readonly id: string;
    readonly path: string;
  }) {
    const [device, stored, installed] = yield* Effect.all(
      [
        settings.read({ kind: "device" }),
        settings.read({
          kind: "project",
          projectId: project.id,
          path: project.path,
        }),
        Effect.forEach(apps, foundBy, { concurrency: "unbounded" }),
      ],
      { concurrency: "unbounded" },
    );
    // In the catalog's order.
    const detected = installed.flatMap((found) =>
      found === undefined
        ? []
        : [
            {
              kind: "detected" as const,
              id: `app:${found.app.id}`,
              label: found.app.label,
              available: true as const,
              ...found,
            },
          ],
    );
    const configured =
      typeof stored?.defaultBranch === "string" &&
      stored.defaultBranch.trim() !== "";
    const custom = [
      ...decodedLaunchers(device).custom,
      ...(configured ? decodedLaunchers(stored).custom : []),
    ].map(({ id, label, command }) => ({
      kind: "custom" as const,
      id: `custom:${id ?? ""}`,
      label: label ?? "",
      command: command ?? "",
    }));
    return [...detected, ...custom] satisfies ReadonlyArray<Launchable>;
  });

  const installed = Effect.fn("Launchers.installed")(function* (id: string) {
    const app = apps.find((entry) => entry.id === id);
    return app !== undefined && (yield* available(app)) ? app : undefined;
  });

  return Launchers.of({ catalog: listCatalog, row, launchable, installed });
});

export const layer = Layer.effect(Launchers, make);
