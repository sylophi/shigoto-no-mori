import {
  RegistryFileSchema,
  ShelfSnapshotSchema,
  StateFileSchema,
} from "@shigomori/contracts/schemas/dataDir";
import { ShigomoriWorktreeDataSchema } from "@shigomori/contracts/schemas/config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Paths from "../Paths.ts";

export class StoreImportError extends Schema.TaggedError<StoreImportError>()(
  "StoreImportError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `${this.path} could not be imported into the store. Fix the file or move it aside, then retry.`;
  }
}

const isAbsent = (error: PlatformError.PlatformError) =>
  Predicate.isTagged(error.reason, "NotFound") ||
  (Predicate.hasProperty(error.cause, "code") &&
    error.cause.code === "ENOTDIR");

type JsonObject = { readonly [key: string]: unknown };

const JsonObjectText = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Unknown),
);

// One key's value, none when absent or (logged) when it doesn't parse.
const lenientKey = <S extends Schema.Decoder<unknown>>(
  file: string,
  key: string,
  schema: S,
  value: unknown,
): Effect.Effect<Option.Option<S["Type"]>> =>
  value === undefined
    ? Effect.succeed(Option.none())
    : Schema.decodeUnknownEffect(schema)(value).pipe(
        Effect.map((decoded) => Option.some<S["Type"]>(decoded)),
        Effect.catchTags({
          SchemaError: () =>
            Effect.logWarning("Skipped a key the store could not import").pipe(
              Effect.annotateLogs({ path: file, key }),
              Effect.as(Option.none<S["Type"]>()),
            ),
        }),
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
// files stay where they are. What the CLI refuses to run without fails
// the import: a registry, config or project file that can't be read,
// and a project list that doesn't parse. What it reads as a hint (use
// logs, marks, a worktree's title) is skipped with a warning when it
// doesn't parse.
export const importJson = Effect.gen(function* () {
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
        StoreImportError: (error) =>
          Effect.logWarning("Skipped a file the store could not import").pipe(
            Effect.annotateLogs({ path: file, cause: String(error.cause) }),
            Effect.as(Option.none<JsonObject>()),
          ),
      }),
    );

  const insertAll = <Row extends Record<string, unknown>>(
    table: string,
    rows: ReadonlyArray<Row>,
  ) =>
    rows.length === 0
      ? Effect.void
      : sql`INSERT INTO ${sql(table)} ${sql.insert(rows)}`;

  const registryFile = path.join(dataDir, "registry.json");
  const stateFile = path.join(dataDir, "state.json");
  const registry = yield* readDocument(registryFile);
  // Until registry.json first existed, the projects and the shelf lived
  // in state.json, so it is read as strictly as the registry then.
  const state = Option.isSome(registry)
    ? yield* lenientDocument(stateFile)
    : yield* readDocument(stateFile);
  const stateDoc: JsonObject = Option.getOrElse(state, () => ({}));
  const registryDoc: JsonObject = Option.getOrElse(registry, () => stateDoc);
  const registrySource = Option.isSome(registry) ? registryFile : stateFile;

  const projects = yield* Schema.decodeUnknownEffect(
    Schema.UndefinedOr(RegistryFileSchema.fields.projects),
  )(registryDoc.projects).pipe(
    Effect.mapError(
      (cause) => new StoreImportError({ path: registrySource, cause }),
    ),
  );
  const seen = new Set<string>();
  yield* insertAll(
    "projects",
    (projects ?? [])
      .filter(({ id }) => !seen.has(id) && seen.add(id))
      .map(({ id, name, path: at }, position) => ({
        id,
        name,
        path: at,
        position,
      })),
  );

  const order = yield* lenientKey(
    registryFile,
    "projectOrder",
    RegistryFileSchema.fields.projectOrder,
    Option.isSome(registry) ? registryDoc.projectOrder : undefined,
  );
  yield* insertAll(
    "project_order",
    [...new Set(Option.getOrElse(order, () => []))].map(
      (projectPath, position) => ({ path: projectPath, position }),
    ),
  );

  for (const [key, mark] of [
    ["shelvedWorktrees", "shelved"],
    ["autoPullWorktrees", "autoPull"],
  ] as const) {
    const marks = yield* lenientKey(
      registrySource,
      key,
      RegistryFileSchema.fields[key],
      registryDoc[key],
    );
    yield* insertAll(
      "worktree_marks",
      Object.entries(Option.getOrElse(marks, () => ({})))
        .filter(([, on]) => on)
        .map(([worktree_id]) => ({ worktree_id, mark })),
    );
  }

  if (Option.isSome(registry)) {
    const snapshots = yield* lenientKey(
      registryFile,
      "shelfSnapshots",
      RegistryFileSchema.fields.shelfSnapshots,
      registryDoc.shelfSnapshots,
    );
    yield* insertAll(
      "shelf_snapshots",
      Object.entries(Option.getOrElse(snapshots, () => ({}))).flatMap(
        ([worktree_id, entry]) =>
          Option.match(Schema.decodeUnknownOption(ShelfSnapshotSchema)(entry), {
            onNone: () => [],
            onSome: ({ at, head, changed }) => [
              { worktree_id, at, head, changed },
            ],
          }),
      ),
    );

    const deviceId = yield* lenientKey(
      registryFile,
      "deviceId",
      RegistryFileSchema.fields.deviceId,
      registryDoc.deviceId,
    );
    yield* insertAll(
      "device",
      Option.toArray(deviceId).map((device_id) => ({ id: 1, device_id })),
    );

    const shared = yield* lenientKey(
      registryFile,
      "sharedSettings",
      RegistryFileSchema.fields.sharedSettings,
      registryDoc.sharedSettings,
    );
    yield* insertAll(
      "shared_settings",
      Object.entries(
        Option.match(shared, {
          onNone: () => ({}),
          onSome: ({ entries }) => entries,
        }),
      ).map(([key, entry]) => ({ key, entry: JSON.stringify(entry) })),
    );
  }

  const stateKey = <K extends keyof typeof StateFileSchema.fields>(key: K) =>
    lenientKey(stateFile, key, StateFileSchema.fields[key], stateDoc[key]);
  const projectUses = yield* stateKey("projectUseLog");
  const launcherUses = yield* stateKey("launcherUseLog");
  const scriptUses = yield* stateKey("packageScriptUseLog");
  yield* insertAll("usage", [
    ...Object.entries(Option.getOrElse(projectUses, () => ({}))).flatMap(
      ([projectId, times]) => uses("project", projectId, "", times),
    ),
    ...Object.entries(Option.getOrElse(launcherUses, () => ({}))).flatMap(
      ([launcherId, times]) => uses("launcher", "", launcherId, times),
    ),
    ...Object.entries(Option.getOrElse(scriptUses, () => ({}))).flatMap(
      ([projectId, scripts]) =>
        Object.entries(scripts).flatMap(([script, times]) =>
          uses("script", projectId, script, times),
        ),
    ),
  ]);

  const sorts = yield* stateKey("packageScriptSort");
  yield* insertAll(
    "script_sort",
    Object.entries(Option.getOrElse(sorts, () => ({}))).map(
      ([project_id, mode]) => ({ project_id, mode }),
    ),
  );
  for (const [key, list] of [
    ["packageScriptOrder", "order"],
    ["packageScriptLaunchRow", "launchRow"],
  ] as const) {
    const lists = yield* stateKey(key);
    yield* insertAll(
      "script_lists",
      Object.entries(Option.getOrElse(lists, () => ({}))).flatMap(
        ([project_id, names]) =>
          names.map((name, position) => ({ project_id, list, position, name })),
      ),
    );
  }

  const config = yield* readDocument(path.join(dataDir, "config.json"));
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
      Effect.catchIf(isAbsent, () => Effect.succeed<ReadonlyArray<string>>([])),
      Effect.mapError((cause) => new StoreImportError({ path: dir, cause })),
    );

  const projectsDir = path.join(dataDir, "projects");
  for (const projectId of yield* listDirectory(projectsDir)) {
    const projectDir = path.join(projectsDir, projectId);
    const projectConfig = yield* readDocument(
      path.join(projectDir, "project.json"),
    );
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
      const data = yield* lenientKey(
        filePath,
        "worktree data",
        ShigomoriWorktreeDataSchema,
        doc.value,
      );
      if (Option.isNone(data)) continue;
      const { title, description, describedAt, ports } = data.value;
      yield* insertAll("worktree_data", [
        {
          project_id: projectId,
          worktree_id: file.slice(0, -".json".length),
          title: title ?? null,
          description: description ?? null,
          described_at: describedAt ?? null,
          ports: ports === undefined ? null : JSON.stringify(ports),
        },
      ]);
    }
  }
});
