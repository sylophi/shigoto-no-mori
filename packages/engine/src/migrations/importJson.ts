import {
  RegistryFileSchema,
  ShelfSnapshotSchema,
  StateFileSchema,
} from "@shigomori/contracts/schemas/dataDir";
import { ShigomoriWorktreeDataSchema } from "@shigomori/contracts/schemas/config";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Paths from "../Paths.ts";
import { isAbsent } from "../platformErrors.ts";

export class StoreImportError extends Schema.TaggedError<StoreImportError>()(
  "StoreImportError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `${this.path} could not be imported into the store. Fix the file or move it aside, then retry.`;
  }
}

type JsonObject = { readonly [key: string]: unknown };

const JsonObjectText = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Unknown),
);

// A file or key the import does without, logged.
const skipped = <A>(file: string, what: string, fallback: A) =>
  Effect.logWarning("Skipped what the store could not import").pipe(
    Effect.annotateLogs({ path: file, what }),
    Effect.as(fallback),
  );

// One key's value, `fallback` when absent or when it doesn't parse.
const lenientKey = <S extends Schema.Decoder<unknown>>(
  file: string,
  key: string,
  schema: S,
  value: unknown,
  fallback: S["Type"],
): Effect.Effect<S["Type"]> =>
  value === undefined
    ? Effect.succeed(fallback)
    : Schema.decodeUnknownEffect(schema)(value).pipe(
        Effect.catchTags({ SchemaError: () => skipped(file, key, fallback) }),
      );

const uses = (
  log: string,
  scope: string,
  name: string,
  times: ReadonlyArray<number>,
) => times.map((at) => ({ log, scope, name, at }));

// A settings document keeps every key as it was stored, each value
// checked when it is read.
const configRows = (doc: Record<string, unknown>) =>
  Object.entries(doc)
    .filter(([key]) => key !== "schemaVersion")
    .map(([key, value]) => ({ key, value: JSON.stringify(value) }));

const FRESH_INSTALL = { doubutsuNames: true };

// The 2.x data dir's JSON files, copied into the store's tables. The
// files stay where they are. What the Go sm refused to run without fails

// the import: a registry, config or project file that can't be read,
// and a project list that doesn't parse. What it reads as a hint (use
// logs, marks, a worktree's title) is skipped with a warning when it
// doesn't parse. `lenient` refuses nothing: what can't be read strictly
// is skipped, as the Go sm read around a file it can't use, which is
// how the doctor reads a data dir the store refused.
export const importFiles = (lenient: boolean) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { dataDir } = yield* Paths.Paths;

    // The document at `file` as an object, none when the file is absent.
    const readDocument = (
      file: string,
    ): Effect.Effect<Option.Option<JsonObject>, StoreImportError> =>
      Effect.gen(function* () {
        const text = yield* fs.readFileString(file).pipe(
          Effect.map(Option.some),
          Effect.catchIf(isAbsent, () => Effect.succeed(Option.none<string>())),
        );
        if (Option.isNone(text)) return Option.none();
        return Option.some(
          yield* Schema.decodeUnknownEffect(JsonObjectText)(text.value),
        );
      }).pipe(
        Effect.mapError((cause) => new StoreImportError({ path: file, cause })),
      );

    const lenientDocument = (file: string) =>
      readDocument(file).pipe(
        Effect.catchTags({
          StoreImportError: () =>
            skipped(file, "the file", Option.none<JsonObject>()),
        }),
      );

    const strictDocument = (file: string) =>
      lenient ? lenientDocument(file) : readDocument(file);

    // In statements of a few thousand values, under SQLite's limit on
    // bound parameters (a long use log has tens of thousands of rows).
    const insertAll = <Row extends Record<string, unknown>>(
      table: string,
      rows: ReadonlyArray<Row>,
    ) =>
      Effect.forEach(
        Arr.chunksOf(rows, 1000),
        (chunk) => sql`INSERT INTO ${sql(table)} ${sql.insert(chunk)}`,
        { discard: true },
      );

    const registryFile = path.join(dataDir, "registry.json");
    const stateFile = path.join(dataDir, "state.json");
    const registry = yield* strictDocument(registryFile);
    const state = yield* lenientDocument(stateFile);
    const stateDoc: JsonObject = Option.getOrElse(state, () => ({}));
    const registryDoc: JsonObject = Option.getOrElse(registry, () => ({}));
    const registryKey = <K extends keyof typeof RegistryFileSchema.fields>(
      key: K,
      fallback: (typeof RegistryFileSchema.fields)[K]["Type"],
    ) =>
      lenientKey(
        registryFile,
        key,
        RegistryFileSchema.fields[key],
        registryDoc[key],
        fallback,
      );
    const stateKey = <K extends keyof typeof StateFileSchema.fields>(
      key: K,
      fallback: (typeof StateFileSchema.fields)[K]["Type"],
    ) =>
      lenientKey(
        stateFile,
        key,
        StateFileSchema.fields[key],
        stateDoc[key],
        fallback,
      );

    const projects = Arr.dedupeWith(
      (yield* Schema.decodeUnknownEffect(
        Schema.UndefinedOr(RegistryFileSchema.fields.projects),
      )(registryDoc.projects).pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            lenient
              ? skipped(registryFile, "projects", undefined)
              : Effect.fail(
                  new StoreImportError({ path: registryFile, cause }),
                ),
        }),
      )) ?? [],
      (a, b) => a.id === b.id,
    );
    yield* insertAll(
      "projects",
      projects.map((project, position) => ({
        id: project.id ?? "",
        name: project.name ?? "",
        path: project.path ?? "",
        position,
      })),
    );

    for (const [key, mark] of [
      ["shelvedWorktrees", "shelved"],
      ["autoPullWorktrees", "autoPull"],
    ] as const) {
      yield* insertAll(
        "worktree_marks",
        Object.entries(yield* registryKey(key, {}))
          .filter(([, on]) => on)
          .map(([worktree_id]) => ({ worktree_id, mark })),
      );
    }

    yield* insertAll(
      "project_order",
      Arr.dedupe(yield* registryKey("projectOrder", [])).map(
        (projectPath, position) => ({ path: projectPath, position }),
      ),
    );
    yield* insertAll(
      "shelf_snapshots",
      Object.entries(yield* registryKey("shelfSnapshots", {})).flatMap(
        ([worktree_id, entry]) =>
          Option.match(Schema.decodeUnknownOption(ShelfSnapshotSchema)(entry), {
            onNone: () => [],
            onSome: ({ at, head, changed }) => [
              { worktree_id, at, head, changed },
            ],
          }),
      ),
    );
    const deviceId = yield* registryKey("deviceId", "");
    yield* insertAll(
      "device",
      deviceId === "" ? [] : [{ id: 1, device_id: deviceId }],
    );
    const shared = yield* registryKey("sharedSettings", { entries: {} });
    yield* insertAll(
      "shared_settings",
      Object.entries(shared.entries).map(([key, entry]) => ({
        key,
        entry: JSON.stringify(entry),
      })),
    );

    yield* insertAll("usage", [
      ...Object.entries(yield* stateKey("projectUseLog", {})).flatMap(
        ([projectId, times]) => uses("project", projectId, "", times),
      ),
      ...Object.entries(yield* stateKey("launcherUseLog", {})).flatMap(
        ([launcherId, times]) => uses("launcher", "", launcherId, times),
      ),
      ...Object.entries(yield* stateKey("packageScriptUseLog", {})).flatMap(
        ([projectId, scripts]) =>
          Object.entries(scripts).flatMap(([script, times]) =>
            uses("script", projectId, script, times),
          ),
      ),
    ]);
    yield* insertAll(
      "script_sort",
      Object.entries(yield* stateKey("packageScriptSort", {})).map(
        ([project_id, mode]) => ({ project_id, mode }),
      ),
    );
    for (const [key, list] of [
      ["packageScriptOrder", "order"],
      ["packageScriptLaunchRow", "launchRow"],
    ] as const) {
      yield* insertAll(
        "script_lists",
        Object.entries(yield* stateKey(key, {})).flatMap(
          ([project_id, names]) =>
            names.map((name, position) => ({
              project_id,
              list,
              position,
              name,
            })),
        ),
      );
    }

    const config = yield* strictDocument(path.join(dataDir, "config.json"));
    // A data dir nothing has used yet starts with the settings of a fresh
    // install. One from before doubutsuNames defaulted on keeps it off.
    const fresh =
      Option.isNone(registry) && Option.isNone(state) && Option.isNone(config);
    yield* insertAll(
      "device_config",
      configRows(Option.getOrElse(config, () => (fresh ? FRESH_INSTALL : {}))),
    );

    const listDirectory = (dir: string) =>
      fs.readDirectory(dir).pipe(
        Effect.catchIf(
          (error) => lenient || isAbsent(error),
          () => Effect.succeed<ReadonlyArray<string>>([]),
        ),
        Effect.mapError((cause) => new StoreImportError({ path: dir, cause })),
      );

    // A registered project's settings are read as strictly as the
    // registry. Another folder (a terrier project's, or one a removal left
    // behind) is read as a hint.
    const registered = new Set(projects.map((project) => project.id ?? ""));
    const projectsDir = path.join(dataDir, "projects");
    for (const projectId of yield* listDirectory(projectsDir)) {
      const projectDir = path.join(projectsDir, projectId);
      const configFile = path.join(projectDir, "project.json");
      const projectConfig = registered.has(projectId)
        ? yield* strictDocument(configFile)
        : yield* lenientDocument(configFile);
      yield* insertAll(
        "project_config",
        configRows(Option.getOrElse(projectConfig, () => ({}))).map(
          ({ key, value }) => ({ project_id: projectId, key, value }),
        ),
      );

      const worktreesDir = path.join(projectDir, "worktrees");
      for (const file of yield* listDirectory(worktreesDir)) {
        if (!file.endsWith(".json")) continue;
        const filePath = path.join(worktreesDir, file);
        const doc = yield* lenientDocument(filePath);
        if (Option.isNone(doc)) continue;
        const fields = ShigomoriWorktreeDataSchema.fields;
        const dataKey = <K extends keyof typeof fields>(key: K) =>
          lenientKey(filePath, key, fields[key], doc.value[key], undefined);
        const ports = yield* dataKey("ports");
        yield* sql`INSERT INTO worktree_data ${sql.insert({
          project_id: projectId,
          worktree_id: file.slice(0, -".json".length),
          title: (yield* dataKey("title")) ?? null,
          description: (yield* dataKey("description")) ?? null,
          described_at: (yield* dataKey("describedAt")) ?? null,
          ports: ports === undefined ? null : JSON.stringify(ports),
        })}`;
      }
    }
  });

// The store's import migration.
export const importJson = importFiles(false);

// One key of registry.json read as a hint, for a migration that comes
// after the import: the file stays where it is, so a table added later
// takes its key from it the way the import took the others. Absent,
// unreadable or unparsable reads as `fallback`.
export const registryHint = <K extends keyof typeof RegistryFileSchema.fields>(
  key: K,
  fallback: (typeof RegistryFileSchema.fields)[K]["Type"],
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { dataDir } = yield* Paths.Paths;
    const file = path.join(dataDir, "registry.json");
    const text = yield* fs.readFileString(file).pipe(
      Effect.map(Option.some),
      Effect.catchIf(isAbsent, () => Effect.succeed(Option.none<string>())),
      Effect.catchTags({
        PlatformError: () => skipped(file, "the file", Option.none<string>()),
      }),
    );
    if (Option.isNone(text)) return fallback;
    const doc = yield* Schema.decodeUnknownEffect(JsonObjectText)(
      text.value,
    ).pipe(
      Effect.catchTags({
        SchemaError: () => skipped(file, "the file", {} as JsonObject),
      }),
    );
    return yield* lenientKey(
      file,
      key,
      RegistryFileSchema.fields[key],
      doc[key],
      fallback,
    );
  });
