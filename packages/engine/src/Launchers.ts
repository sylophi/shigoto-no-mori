import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import catalog from "./data/launcher-catalog.json" with { type: "json" };
import * as Paths from "./Paths.ts";

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

export class Launchers extends Context.Service<
  Launchers,
  {
    // Every app the catalog knows, installed or not, by label.
    readonly catalog: Effect.Effect<ReadonlyArray<CatalogEntry>>;
  }
>()("sm/engine/Launchers") {}

const apps: ReadonlyArray<CatalogApp> = catalog;

// Code-unit order, as Go compares strings.
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { home } = yield* Paths.Paths;
  const searchPath = yield* Config.String("PATH").pipe(Config.withDefault(""));
  const appFolders = [
    "/Applications",
    path.join(home, "Applications"),
    "/System/Applications",
  ];

  const exists = (file: string) =>
    fs.exists(file).pipe(Effect.orElseSucceed(() => false));

  // Whether `name` is an executable file in a PATH directory.
  const onPath = (name: string) =>
    Effect.gen(function* () {
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

  return Launchers.of({ catalog: listCatalog });
});

export const layer = Layer.effect(Launchers, make);
