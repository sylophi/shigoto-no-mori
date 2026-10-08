import { WEB_GITHUB_ID } from "@shigomori/contracts/schemas/launchers";
import * as Config from "effect/Config";
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
// its command line tool on PATH. A deep link with {path} opens it.
type CatalogApp = {
  readonly id: string;
  readonly label: string;
  readonly bundleNames: ReadonlyArray<string>;
  readonly cli?: string;
  readonly deepLink?: string;
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
  }
>()("sm/engine/Launchers") {}

// The GitHub page of a remote URL, none for another host.
const GITHUB_REMOTE =
  /^(?:git@|ssh:\/\/git@|https:\/\/)([^:/]*github[^:/]*)[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/;

export const githubPageOf = (remoteUrl: string) => {
  const match = GITHUB_REMOTE.exec(remoteUrl.trim());
  return match === null
    ? undefined
    : `https://${match[1]}/${match[2]}/${match[3]}`;
};

// The custom launchers a settings document stores. One that isn't an
// object of strings is left out.
const customOf = (value: unknown): ReadonlyArray<RowEntry> =>
  Array.isArray(value)
    ? value.flatMap((entry: unknown) => {
        const { id, label } = (entry ?? {}) as {
          id?: unknown;
          label?: unknown;
        };
        return typeof id === "string" && typeof label === "string"
          ? [{ kind: "custom" as const, id: `custom:${id}`, label }]
          : [];
      })
    : [];

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
  const appFolders = [
    "/Applications",
    path.join(home, "Applications"),
    "/System/Applications",
  ];

  const exists = (file: string) =>
    fs.exists(file).pipe(Effect.orElseSucceed(() => false));

  // Whether `name` is an executable file in a PATH directory.
  // Read on each ask, since the host outlives a tool's install.
  const onPath = (name: string) =>
    Effect.gen(function* () {
      const searchPath = yield* Config.String("PATH").pipe(
        Config.withDefault(""),
        Effect.orElseSucceed(() => ""),
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
      for (const bundle of app.bundleNames) {
        if (bundle === "__finder__") return true;
        for (const folder of appFolders) {
          if (yield* exists(path.join(folder, bundle))) return true;
        }
      }
      return app.cli !== undefined && (yield* onPath(app.cli));
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
    const [device, stored, installed, page, stats] = yield* Effect.all(
      [
        settings.read({ kind: "device" }),
        settings.read({
          kind: "project",
          projectId: project.id,
          path: project.path,
        }),
        Effect.filter(apps, available, { concurrency: "unbounded" }),
        git.run(project.path, ["remote", "get-url", "origin"]).pipe(
          Effect.map(githubPageOf),
          Effect.orElseSucceed(() => undefined),
        ),
        usage.stats("launcher", ""),
      ],
      { concurrency: "unbounded" },
    );
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
      ...(page === undefined
        ? []
        : [{ kind: "web" as const, id: WEB_GITHUB_ID, label: "GitHub" }]),
      ...customOf(device?.launchers),
      ...(configured ? customOf(stored?.launchers) : []),
    ];
    const hidden = new Set(
      Array.isArray(device?.hiddenLaunchers)
        ? device.hiddenLaunchers.filter((id) => typeof id === "string")
        : [],
    );
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

  return Launchers.of({ catalog: listCatalog, row });
});

export const layer = Layer.effect(Launchers, make);
