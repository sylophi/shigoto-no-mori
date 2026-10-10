import { WEB_GITHUB_ID } from "@shigomori/contracts/schemas/launchers";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import catalog from "./data/launcher-catalog.json" with { type: "json" };
import * as EngineConfig from "./Config.ts";
import * as Git from "./Git.ts";
import * as Paths from "./Paths.ts";
import * as Usage from "./Usage.ts";

// One app the launcher row knows, as the catalog lists it: found by its
// bundle name in the app folders (or "__finder__", always there), or by
// its command line tool on PATH. A deep link with {path} opens it, and
// openArgs are the launch arguments of one that takes the folder that
// way. A terminal tool is the command line inTerminal runs in the
// user's terminal, found by its first word on PATH.
export type CatalogApp = {
  readonly id: string;
  readonly label: string;
  readonly bundleNames?: ReadonlyArray<string>;
  readonly cli?: string;
  readonly deepLink?: string;
  readonly openArgs?: ReadonlyArray<string>;
  readonly inTerminal?: string;
};

export type CatalogEntry = {
  readonly kind: "detected";
  readonly id: string;
  readonly label: string;
  readonly available: boolean;
};

// One launcher on a project's row: an installed app, the repo's GitHub
// page, or a custom command (the device's, then the project's).
export type RowEntry = {
  readonly kind: "detected" | "web" | "custom";
  readonly id: string;
  readonly label: string;
  // Set on detected apps, which are installed by being listed.
  readonly available?: true;
};

// A launcher with what launching it takes: an installed app with the
// bundle or tool it was found by, the repo's GitHub page, or a custom
// command line.
export type Launchable =
  | (RowEntry & {
      readonly kind: "detected";
      readonly app: CatalogApp;
      // The first bundle found ("__finder__" for Finder), if any.
      readonly bundle: string | undefined;
      readonly cliOnPath: boolean;
    })
  | (RowEntry & { readonly kind: "web"; readonly url: string })
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
    // order of assembly: installed apps, the GitHub page, the device's
    // custom commands, then the project's.
    readonly launchable: (project: {
      readonly id: string;
      readonly path: string;
    }) => Effect.Effect<ReadonlyArray<Launchable>>;
  }
>()("sm/engine/Launchers") {}

// Whether a remote URL is a GitHub repo, which gets the web entry.
const GITHUB_REMOTE =
  /^(?:git@|ssh:\/\/git@|https:\/\/)([^:/]*github[^:/]*)[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/;

export const isGithubRemote = (remoteUrl: string) =>
  GITHUB_REMOTE.test(remoteUrl.trim());

// The repo's page on GitHub, for a remote that is a GitHub repo.
const githubPage = (remoteUrl: string) => {
  const [, host, owner, repo] = GITHUB_REMOTE.exec(remoteUrl.trim()) ?? [];
  return host === undefined || owner === undefined || repo === undefined
    ? undefined
    : `https://${host}/${owner}/${repo}`;
};

// A JSON field Go read into a string: absent, null or text.
const text = (value: unknown) =>
  value === undefined || value === null || typeof value === "string";

// A settings document's custom launchers, each field as stored, and its
// hidden ids, as the Go sm decoded them: a missing field reads as empty,
// and a document holding one of the wrong type reads as the defaults
// (none of either).
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
        (typeof entry === "object" &&
          !Array.isArray(entry) &&
          ["id", "label", "command"].every((field) =>
            text((entry as Record<string, unknown>)[field]),
          )),
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

// The same, as rows.
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
export const appFoldersOf = (path: Path.Path, home: string) => [
  "/Applications",
  path.join(home, "Applications"),
  "/System/Applications",
];

const apps: ReadonlyArray<CatalogApp> = catalog;

// Code-unit order, as Go compares strings.
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { home } = yield* Paths.Paths;
  const settings = yield* EngineConfig.Config;
  const git = yield* Git.Git;
  const usage = yield* Usage.Usage;
  const appFolders = appFoldersOf(path, home);
  // The provider the engine was built with, not the caller's: a fiber
  // with none set reads a copy of the environment taken once.
  const configProvider = yield* ConfigProvider.ConfigProvider;

  const exists = (file: string) =>
    fs.exists(file).pipe(Effect.orElseSucceed(() => false));

  // Whether `name` is an executable file in a PATH directory.
  // Read on each ask, since the host outlives a tool's install.
  const onPath = (name: string) =>
    Effect.gen(function* () {
      const searchPath = yield* Config.String("PATH").pipe(
        Config.withDefault(""),
        Effect.orElseSucceed(() => ""),
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider),
      );
      for (const dir of searchPath.split(":")) {
        if (dir === "") continue;
        const executable = yield* fs.stat(path.join(dir, name)).pipe(
          Effect.map(
            (info) => info.type === "File" && (info.mode & 0o111) !== 0,
          ),
          Effect.orElseSucceed(() => false),
        );
        if (executable) return true;
      }
      return false;
    });

  const available = (app: CatalogApp) =>
    Effect.gen(function* () {
      for (const bundle of app.bundleNames ?? []) {
        if (bundle === "__finder__") return true;
        for (const folder of appFolders) {
          if (yield* exists(path.join(folder, bundle))) return true;
        }
      }
      if (app.cli !== undefined && (yield* onPath(app.cli))) return true;
      const tool = app.inTerminal?.trim().split(/\s+/)[0];
      return tool !== undefined && (yield* onPath(tool));
    });

  const listCatalog = Effect.forEach(
    apps,
    (app) =>
      Effect.map(
        available(app),
        (installed): CatalogEntry => ({
          kind: "detected",
          id: `app:${app.id}`,
          label: app.label,
          available: installed,
        }),
      ),
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
    const [device, stored, installed, onGithub, stats] = yield* Effect.all(
      [
        settings.read({ kind: "device" }),
        settings.read({
          kind: "project",
          projectId: project.id,
          path: project.path,
        }),
        Effect.filter(apps, available, { concurrency: "unbounded" }),
        git.run(project.path, ["remote", "get-url", "origin"]).pipe(
          Effect.map(isGithubRemote),
          Effect.orElseSucceed(() => false),
        ),
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
      ...(onGithub
        ? [{ kind: "web" as const, id: WEB_GITHUB_ID, label: "GitHub" }]
        : []),
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

  // The bundle an app was found by, in its own order of names.
  const bundleOf = (app: CatalogApp) =>
    Effect.gen(function* () {
      for (const bundle of app.bundleNames ?? []) {
        if (bundle === "__finder__") return bundle;
        for (const folder of appFolders) {
          const found = path.join(folder, bundle);
          if (yield* exists(found)) return found;
        }
      }
      return undefined;
    });

  const launchable = Effect.fn("Launchers.launchable")(function* (project: {
    readonly id: string;
    readonly path: string;
  }) {
    const [device, stored, installed, remote] = yield* Effect.all(
      [
        settings.read({ kind: "device" }),
        settings.read({
          kind: "project",
          projectId: project.id,
          path: project.path,
        }),
        // In the catalog's order, which Effect.filter doesn't keep.
        Effect.forEach(apps, available, { concurrency: "unbounded" }).pipe(
          Effect.map((found) => apps.filter((_, index) => found[index])),
        ),
        git
          .run(project.path, ["remote", "get-url", "origin"])
          .pipe(Effect.orElseSucceed(() => "")),
      ],
      { concurrency: "unbounded" },
    );
    const detected = yield* Effect.forEach(installed, (app) =>
      Effect.gen(function* () {
        return {
          kind: "detected" as const,
          id: `app:${app.id}`,
          label: app.label,
          available: true as const,
          app,
          bundle: yield* bundleOf(app),
          cliOnPath: app.cli !== undefined && (yield* onPath(app.cli)),
        };
      }),
    );
    const page = githubPage(remote);
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
    return [
      ...detected,
      ...(page === undefined
        ? []
        : [
            {
              kind: "web" as const,
              id: WEB_GITHUB_ID,
              label: "GitHub",
              url: page,
            },
          ]),
      ...custom,
    ] satisfies ReadonlyArray<Launchable>;
  });

  return Launchers.of({ catalog: listCatalog, row, launchable });
});

export const layer = Layer.effect(Launchers, make);
