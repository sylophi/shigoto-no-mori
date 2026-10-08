import {
  DEVICE_SETTINGS_DEFAULTS,
  DeviceSettingsPatchSchema,
  modeledKeyPaths,
  PROJECT_CONFIG_DEFAULTS,
  ShigomoriConfigSchema,
} from "@shigomori/contracts/schemas/config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import * as SqlClient from "effect/sql/SqlClient";
import {
  type ConfigDoc,
  type ConfigKey,
  expandHome,
  docGet,
  docSet,
  docDelete,
  mergeConfigDoc,
  settingKeys,
} from "./configDoc.ts";
import * as Paths from "./Paths.ts";

// Which settings document a call reads or writes: the device's, or a
// project's.
export type ConfigScope =
  | { readonly kind: "device" }
  | { readonly kind: "project"; readonly projectId: string };

// One row of a settings listing: the key's effective value, and whether
// the document sets it (a key it doesn't takes its default, or null).
export type Setting = {
  readonly key: string;
  readonly value: unknown;
  readonly set: boolean;
};

export class UnknownConfigKey extends Schema.TaggedError<UnknownConfigKey>()(
  "UnknownConfigKey",
  { key: Schema.String, keys: Schema.Array(Schema.String) },
) {
  override get message(): string {
    // The settings that moved into the app's client settings get a
    // pointer to their new home.
    const moved =
      this.key === "theme" || this.key === "doubutsu"
        ? " Appearance moved into the app's client settings (Settings -> Appearance)."
        : "";
    return `Unknown key ${JSON.stringify(this.key)}. Keys: ${this.keys.join(", ")}.${moved}`;
  }
}

// A value `set` can't take for its key, or a key `set` and `unset`
// don't change on their own. The reason is the whole sentence.
export class InvalidConfigValue extends Schema.TaggedError<InvalidConfigValue>()(
  "InvalidConfigValue",
  {
    key: Schema.String,
    reason: Schema.Literals([
      "boolean",
      "enum",
      "positiveInt",
      "absolutePath",
      "required",
      "requiredUnset",
    ]),
    choices: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "boolean":
        return `${this.key} is a boolean: use true or false.`;
      case "enum":
        return `${this.key} must be one of: ${this.choices.join(", ")}.`;
      case "positiveInt":
        return `${this.key} must be a positive integer.`;
      case "absolutePath":
        return `${this.key} must be an absolute path.`;
      case "required":
        return `${this.key} can't be empty: it's required, so set a value instead of clearing it.`;
      case "requiredUnset":
        return `${this.key} can't be cleared: it's required, so set a different value instead.`;
    }
  }
}

// A list-valued key, which has its own verbs (or the app) instead of
// `set`. `verbs` names them, without the binary.
export class StructuredConfigKey extends Schema.TaggedError<StructuredConfigKey>()(
  "StructuredConfigKey",
  { key: Schema.String, verbs: Schema.String },
) {}

// A whole-document write whose payload doesn't fit the schema.
export class InvalidConfigDocument extends Schema.TaggedError<InvalidConfigDocument>()(
  "InvalidConfigDocument",
  { problem: Schema.String },
) {
  override get message(): string {
    return this.problem;
  }
}

export class Config extends Context.Service<
  Config,
  {
    // Every setting the scope models, in the order the CLI lists them.
    readonly list: (
      scope: ConfigScope,
    ) => Effect.Effect<ReadonlyArray<Setting>>;
    readonly get: (
      scope: ConfigScope,
      key: string,
    ) => Effect.Effect<Setting, UnknownConfigKey>;
    // The document as stored: no defaults filled in, keys this build
    // doesn't model included. A project with no settings reads as null.
    readonly read: (scope: ConfigScope) => Effect.Effect<ConfigDoc | null>;
    // A setting from its text form (true/on/yes/1, an enum member, a
    // number). A value equal to the default is stored by removing the
    // key. Answers the value stored, or null for a cleared one.
    readonly set: (
      scope: ConfigScope,
      key: string,
      raw: string,
    ) => Effect.Effect<
      unknown,
      UnknownConfigKey | InvalidConfigValue | StructuredConfigKey
    >;
    readonly unset: (
      scope: ConfigScope,
      key: string,
    ) => Effect.Effect<void, UnknownConfigKey | InvalidConfigValue>;
    // The app's whole-document save: a modeled key the payload omits is
    // removed, a null removes its key, objects merge field by field, and
    // a key this build doesn't model survives.
    readonly write: (
      scope: ConfigScope,
      payload: ConfigDoc,
    ) => Effect.Effect<void, InvalidConfigDocument>;
  }
>()("sm/engine/Config") {}

// The CLI's order and the words it shows for each key. A key the
// schema models and this list misses is still listed, last.
const deviceKeys = settingKeys(
  Object.fromEntries(
    Object.entries(DeviceSettingsPatchSchema.struct.fields).map(
      ([name, field]) => [name, field.ast],
    ),
  ),
  DEVICE_SETTINGS_DEFAULTS,
  [
    ["launchScripts", "Show package scripts in the Launch section"],
    ["deleteBranchOnRemove", "Delete the branch when removing its worktree"],
    [
      "autoPopulateInstall",
      "Seed new projects' setup script with `<pm> install`",
    ],
    [
      "autoPullNew",
      "Start new worktrees (and added projects' primaries) with auto-pull on",
    ],
    [
      "autoPullPrimaryOnly",
      "autoPullNew applies to added projects' primaries only",
    ],
    [
      "doubutsuNames",
      "Name new worktrees after Animal Crossing characters (on for new installs)",
    ],
    [
      "codexWorktreeNames",
      "Name Codex-style <name>/<repo> worktrees by their parent folder",
    ],
    [
      "managedOnProjectDrive",
      "Keep managed worktrees on the project's drive when it is an external one",
    ],
    ["portPool", "Provision/release port-pool ports with worktrees"],
    ["terrier", "List terrier-registered repos as projects"],
    ["githubCli", "GitHub CLI integration"],
    [
      "launchers",
      "Global custom launchers (`config launcher`)",
      "config launcher add/rm",
    ],
    ["hiddenLaunchers", "Hidden launcher ids (via edit or the app)"],
  ],
);

const projectKeys = settingKeys(
  Object.fromEntries(
    modeledKeyPaths(ShigomoriConfigSchema).map((path) => [
      path.join("."),
      fieldAt(ShigomoriConfigSchema.ast, path),
    ]),
  ),
  PROJECT_CONFIG_DEFAULTS,
  [
    ["defaultBranch", "Branch new worktrees fork from (required)"],
    ["scripts.setup", "Runs after creating a worktree"],
    ["scripts.teardown", "Runs before removing a worktree"],
    ["worktreeLayout", "Where managed worktrees live"],
    ["customWorktreePath", "Absolute base dir for the custom layout"],
    ["useWorktreeInclude", "Honor the repo's .worktreeinclude file"],
    ["portBase", "port-pool base port"],
    ["lastMergeMethod", "Preferred PR merge method"],
    ["showPrimaryInInbox", "List the primary checkout in the inbox view"],
    [
      "carryOver",
      "Files carried into new worktrees (`carryover` verbs)",
      "projects config carryover add/rm",
    ],
    [
      "launchers",
      "Per-project launchers (`launcher` verbs)",
      "projects config launcher add/rm",
    ],
  ],
);

// The field a dotted key path names, through optional wrappers.
function fieldAt(
  ast: SchemaAST.AST,
  path: ReadonlyArray<string>,
): SchemaAST.AST {
  let current = ast;
  for (const name of path) {
    const objects = SchemaAST.isUnion(current)
      ? current.types.find(SchemaAST.isObjects)
      : current;
    const field =
      objects && SchemaAST.isObjects(objects)
        ? objects.propertySignatures.find((property) => property.name === name)
        : undefined;
    if (!field) throw new Error(`no field ${path.join(".")}`);
    current = field.type;
  }
  return current;
}

const keysOf = (scope: ConfigScope) =>
  scope.kind === "device" ? deviceKeys : projectKeys;

const lookupKey = (scope: ConfigScope, name: string) => {
  const keys = keysOf(scope);
  const key = keys.find((candidate) => candidate.name === name);
  return key
    ? Effect.succeed(key)
    : Effect.fail(
        new UnknownConfigKey({ key: name, keys: keys.map((k) => k.name) }),
      );
};

const listedValue = (key: ConfigKey, doc: ConfigDoc): Setting => {
  const [value, set] = docGet(doc, key.name);
  return { key: key.name, value: set ? value : (key.default ?? null), set };
};

// The text forms `set` takes for each kind of key.
const parseValue = (key: ConfigKey, raw: string, home: string) => {
  const invalid = (reason: InvalidConfigValue["reason"]) =>
    Effect.fail(
      new InvalidConfigValue({ key: key.name, reason, choices: key.choices }),
    );
  switch (key.kind) {
    case "boolean": {
      const word = raw.toLowerCase();
      if (["true", "on", "yes", "1"].includes(word))
        return Effect.succeed(true);
      if (["false", "off", "no", "0"].includes(word))
        return Effect.succeed(false);
      return invalid("boolean");
    }
    case "enum":
      return key.choices.includes(raw) ? Effect.succeed(raw) : invalid("enum");
    case "int": {
      const n = Number(raw);
      return /^[+-]?\d+$/.test(raw) && Number.isSafeInteger(n) && n > 0
        ? Effect.succeed(n)
        : invalid("positiveInt");
    }
    case "string": {
      if (key.name !== "customWorktreePath") return Effect.succeed(raw);
      const absolute = expandHome(home, raw);
      return absolute.startsWith("/")
        ? Effect.succeed(absolute)
        : invalid("absolutePath");
    }
    case "list":
      return Effect.die(new Error("a list key is set through its own verbs"));
  }
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const { home } = yield* Paths.Paths;

  const load = (scope: ConfigScope) =>
    (scope.kind === "device"
      ? sql<{
          key: string;
          value: string;
        }>`SELECT key, value FROM device_config`
      : sql<{ key: string; value: string }>`
          SELECT key, value FROM project_config WHERE project_id = ${scope.projectId}`
    ).pipe(
      Effect.map((rows) =>
        rows.length === 0 && scope.kind === "project"
          ? null
          : Object.fromEntries(
              rows.map(({ key, value }) => [key, JSON.parse(value) as unknown]),
            ),
      ),
    );

  // Stores `next` over `before`, top-level key by key.
  const store = (scope: ConfigScope, before: ConfigDoc, next: ConfigDoc) =>
    Effect.forEach(
      new Set([...Object.keys(before), ...Object.keys(next)]),
      (key) => {
        const encoded = JSON.stringify(next[key]);
        if (encoded === JSON.stringify(before[key])) return Effect.void;
        const statement = !(key in next)
          ? scope.kind === "device"
            ? sql`DELETE FROM device_config WHERE key = ${key}`
            : sql`DELETE FROM project_config
                  WHERE project_id = ${scope.projectId} AND key = ${key}`
          : scope.kind === "device"
            ? sql`INSERT INTO device_config (key, value) VALUES (${key}, ${encoded})
                  ON CONFLICT (key) DO UPDATE SET value = excluded.value`
            : sql`INSERT INTO project_config (project_id, key, value)
                  VALUES (${scope.projectId}, ${key}, ${encoded})
                  ON CONFLICT (project_id, key) DO UPDATE SET value = excluded.value`;
        return Effect.asVoid(statement);
      },
      { discard: true },
    );

  // A read-modify-write of the scope's document in one transaction.
  const update = (scope: ConfigScope, change: (doc: ConfigDoc) => void) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const before = (yield* load(scope)) ?? {};
        const next = structuredClone(before);
        change(next);
        yield* store(scope, before, next);
      }),
    );

  const list = Effect.fn("Config.list")(function* (scope: ConfigScope) {
    const doc = (yield* load(scope)) ?? {};
    return keysOf(scope).map((key) => listedValue(key, doc));
  }, Effect.orDie);

  const get = Effect.fn("Config.get")(function* (
    scope: ConfigScope,
    name: string,
  ) {
    const key = yield* lookupKey(scope, name);
    return listedValue(key, (yield* Effect.orDie(load(scope))) ?? {});
  });

  const read = Effect.fn("Config.read")(function* (scope: ConfigScope) {
    return yield* load(scope);
  }, Effect.orDie);

  const unset = Effect.fn("Config.unset")(function* (
    scope: ConfigScope,
    name: string,
  ) {
    const key = yield* lookupKey(scope, name);
    if (key.required) {
      return yield* new InvalidConfigValue({
        key: key.name,
        reason: "requiredUnset",
        choices: [],
      });
    }
    yield* Effect.orDie(update(scope, (doc) => docDelete(doc, key.name)));
  });

  const set = Effect.fn("Config.set")(function* (
    scope: ConfigScope,
    name: string,
    raw: string,
  ) {
    const key = yield* lookupKey(scope, name);
    if (key.kind === "list") {
      return yield* new StructuredConfigKey({
        key: key.name,
        verbs: key.verbs ?? "",
      });
    }
    if (key.required && raw.trim() === "") {
      return yield* new InvalidConfigValue({
        key: key.name,
        reason: "required",
        choices: [],
      });
    }
    // An empty string clears a text setting.
    if (key.kind === "string" && raw === "") {
      yield* unset(scope, name);
      return null;
    }
    const value = yield* parseValue(key, raw, home);
    yield* Effect.orDie(
      update(scope, (doc) =>
        JSON.stringify(value) === JSON.stringify(key.default)
          ? docDelete(doc, key.name)
          : docSet(doc, key.name, value),
      ),
    );
    return value;
  });

  const write = Effect.fn("Config.write")(function* (
    scope: ConfigScope,
    payload: ConfigDoc,
  ) {
    yield* validate(keysOf(scope), payload);
    yield* Effect.orDie(
      update(scope, (doc) => mergeConfigDoc(keysOf(scope), doc, payload)),
    );
  });

  return Config.of({ list, get, read, set, unset, write });
});

// The shape check a whole-document write passes first: required keys
// are there, and every modeled key present decodes with its schema. A
// null clears its key, so it passes wherever the key may be absent.
const validate = (keys: ReadonlyArray<ConfigKey>, doc: ConfigDoc) =>
  Effect.gen(function* () {
    for (const key of keys) {
      const [value, present, wrongParent] = docGet(doc, key.name);
      if (wrongParent !== undefined) {
        return yield* new InvalidConfigDocument({
          problem: `${wrongParent} must be an object.`,
        });
      }
      if (!present || value === null) {
        if (key.required) {
          return yield* new InvalidConfigDocument({
            problem: `${key.name} is required.`,
          });
        }
        continue;
      }
      if (!key.accepts(value)) {
        return yield* new InvalidConfigDocument({
          problem: `${key.name} ${key.expected}.`,
        });
      }
    }
  });

export const layer = Layer.effect(Config, make);
