import {
  DEVICE_SETTINGS_DEFAULTS,
  DeviceSettingsPatchSchema,
  modeledKeyFields,
  PROJECT_CONFIG_DEFAULTS,
  ShigomoriConfigSchema,
} from "@shigomori/contracts/schemas/config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import {
  type ConfigDoc,
  type ConfigKey,
  carryOverProblem,
  documentProblem,
  docGet,
  docSet,
  docDelete,
  launcherIdProblem,
  launcherProblem,
  mergeConfigDoc,
  settingKeys,
} from "./configDoc.ts";
import * as Git from "./Git.ts";
import * as Paths from "./Paths.ts";

// Which settings document a call reads or writes: the device's, or a
// project's.
export type ConfigScope =
  | { readonly kind: "device" }
  | {
      readonly kind: "project";
      readonly projectId: string;
      // The primary checkout, which a write asks git about.
      readonly path: string;
    };

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

// A list-valued key, which `set` can't change: it has its own verbs, or
// is edited in the file or the app.
export class StructuredConfigKey extends Schema.TaggedError<StructuredConfigKey>()(
  "StructuredConfigKey",
  {
    key: Schema.String,
    verbs: Schema.String,
    orTheApp: Schema.Boolean,
    binaryName: Schema.String,
  },
) {
  override get message(): string {
    const or = this.orTheApp ? " or the app" : "";
    return `${this.key} is structured: use \`${this.binaryName} ${this.verbs}\`${or}.`;
  }
}

// A project's settings must name its default branch, which a write
// would leave out.
export class MissingDefaultBranch extends Schema.TaggedError<MissingDefaultBranch>()(
  "MissingDefaultBranch",
  { projectId: Schema.String, binaryName: Schema.String },
) {
  override get message(): string {
    return `Set the project's default branch first: \`${this.binaryName} projects config set defaultBranch <ref>\`.`;
  }
}

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
    // key. Answers the value stored, none for a cleared one.
    readonly set: (
      scope: ConfigScope,
      key: string,
      raw: string,
    ) => Effect.Effect<
      unknown,
      | UnknownConfigKey
      | InvalidConfigValue
      | StructuredConfigKey
      | MissingDefaultBranch
    >;
    readonly unset: (
      scope: ConfigScope,
      key: string,
    ) => Effect.Effect<
      void,
      UnknownConfigKey | InvalidConfigValue | MissingDefaultBranch
    >;
    // The app's whole-document save: a modeled key the payload omits is
    // removed, a null removes its key, objects merge field by field, and
    // a key this build doesn't model survives.
    readonly write: (
      scope: ConfigScope,
      payload: ConfigDoc,
    ) => Effect.Effect<void, InvalidConfigDocument | MissingDefaultBranch>;
  }
>()("sm/engine/Config") {}

// The keys in the order the CLI lists them. A key the schema models and
// this list misses is still listed, last.
const deviceKeys = settingKeys(
  modeledKeyFields(DeviceSettingsPatchSchema.struct),
  DEVICE_SETTINGS_DEFAULTS,
  [
    "launchScripts",
    "deleteBranchOnRemove",
    "autoPopulateInstall",
    "autoPullNew",
    "autoPullPrimaryOnly",
    "doubutsuNames",
    "codexWorktreeNames",
    "managedOnProjectDrive",
    "portPool",
    "terrier",
    "githubCli",
    "launchers",
    "hiddenLaunchers",
  ],
  {
    launchers: {
      verbs: "config launcher add/rm",
      entryProblem: launcherProblem,
    },
    hiddenLaunchers: { entryProblem: launcherIdProblem },
  },
);

const projectKeys = settingKeys(
  modeledKeyFields(ShigomoriConfigSchema),
  PROJECT_CONFIG_DEFAULTS,
  [
    "defaultBranch",
    "scripts.setup",
    "scripts.teardown",
    "worktreeLayout",
    "customWorktreePath",
    "useWorktreeInclude",
    "portBase",
    "lastMergeMethod",
    "showPrimaryInInbox",
    "carryOver",
    "launchers",
  ],
  {
    carryOver: {
      verbs: "projects config carryover add/rm",
      entryProblem: carryOverProblem,
    },
    launchers: {
      verbs: "projects config launcher add/rm",
      entryProblem: launcherProblem,
    },
  },
);

const keysOf = (scope: ConfigScope) =>
  scope.kind === "device" ? deviceKeys : projectKeys;

// What is wrong with a stored document, by the keys its scope models:
// a value of the wrong type, say. None when nothing is.
export const storedProblem = (scope: ConfigScope, doc: ConfigDoc) =>
  documentProblem(keysOf(scope), doc);

const lookupKey = (scope: ConfigScope, name: string) => {
  const keys = keysOf(scope);
  const key = keys.find((candidate) => candidate.name === name);
  return key
    ? Effect.succeed(key)
    : Effect.fail(
        new UnknownConfigKey({ key: name, keys: keys.map((k) => k.name) }),
      );
};

const missingBranch = (doc: ConfigDoc) => {
  const [branch] = docGet(doc, "defaultBranch");
  return typeof branch !== "string" || branch.trim() === "";
};

const listedValue = (key: ConfigKey, doc: ConfigDoc): Setting => {
  const [value, set] = docGet(doc, key.name);
  return { key: key.name, value: set ? value : (key.default ?? null), set };
};

// The text forms `set` takes for each kind of key but a list.
const parseValue = (
  key: ConfigKey,
  kind: Exclude<ConfigKey["kind"], "list">,
  raw: string,
  expandHome: (raw: string) => string,
) => {
  const invalid = (reason: InvalidConfigValue["reason"]) =>
    Effect.fail(
      new InvalidConfigValue({ key: key.name, reason, choices: key.choices }),
    );
  switch (kind) {
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
      const absolute = expandHome(raw);
      return absolute.startsWith("/")
        ? Effect.succeed(absolute)
        : invalid("absolutePath");
    }
  }
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const { expandHome, binaryName } = yield* Paths.Paths;
  const git = yield* Git.Git;

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
      Effect.orDie,
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

  // A read-modify-write of the scope's document in one transaction. A
  // project's document keeps its default branch, from git when the
  // write would leave it out, and one on the in-project layout hides
  // `.shigomori/` from the primary's git status.
  const update = (scope: ConfigScope, change: (doc: ConfigDoc) => void) => {
    // One try at the write. Without a default branch it fails, unless
    // git named one to fill in.
    const attempt = (fallbackBranch: Option.Option<string>) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const before = (yield* load(scope)) ?? {};
          const next = structuredClone(before);
          change(next);
          if (scope.kind === "project" && missingBranch(next)) {
            if (Option.isNone(fallbackBranch)) {
              return yield* new MissingDefaultBranch({
                projectId: scope.projectId,
                binaryName,
              });
            }
            docSet(next, "defaultBranch", fallbackBranch.value);
          }
          yield* store(scope, before, next);
          return docGet(next, "worktreeLayout")[0] === "in-project";
        }),
      );
    return attempt(Option.none()).pipe(
      // Git is asked outside the write, which holds the store's lock.
      Effect.catchTags({
        MissingDefaultBranch: (missing) =>
          scope.kind === "project"
            ? git
                .resolveDefaultBranch(scope.path)
                .pipe(
                  Effect.flatMap((found) =>
                    Option.isSome(found)
                      ? attempt(found)
                      : Effect.fail(missing),
                  ),
                )
            : Effect.fail(missing),
      }),
      Effect.tap((inProject) =>
        scope.kind === "project" && inProject
          ? git.appendExcludes(scope.path, [".shigomori"])
          : Effect.void,
      ),
      Effect.catchTags({ SqlError: Effect.die }),
    );
  };

  const list = Effect.fn("Config.list")(function* (scope: ConfigScope) {
    const doc = (yield* load(scope)) ?? {};
    return keysOf(scope).map((key) => listedValue(key, doc));
  });

  const get = Effect.fn("Config.get")(function* (
    scope: ConfigScope,
    name: string,
  ) {
    const key = yield* lookupKey(scope, name);
    return listedValue(key, (yield* load(scope)) ?? {});
  });

  const read = Effect.fn("Config.read")(function* (scope: ConfigScope) {
    return yield* load(scope);
  });

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
    yield* update(scope, (doc) => docDelete(doc, key.name));
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
        verbs:
          key.verbs ??
          (scope.kind === "device" ? "config edit" : "projects config edit"),
        orTheApp: key.verbs === undefined,
        binaryName,
      });
    }
    if (key.required && raw.trim() === "") {
      return yield* new InvalidConfigValue({
        key: key.name,
        reason: "required",
        choices: [],
      });
    }
    // An empty string clears a text setting, which answers no value.
    if (key.kind === "string" && raw === "") {
      yield* unset(scope, name);
      return undefined;
    }
    const value = yield* parseValue(key, key.kind, raw, expandHome);
    yield* update(scope, (doc) =>
      JSON.stringify(value) === JSON.stringify(key.default)
        ? docDelete(doc, key.name)
        : docSet(doc, key.name, value),
    );
    return value;
  });

  const write = Effect.fn("Config.write")(function* (
    scope: ConfigScope,
    payload: ConfigDoc,
  ) {
    const problem = documentProblem(keysOf(scope), payload);
    if (problem !== undefined) {
      return yield* new InvalidConfigDocument({ problem });
    }
    yield* update(scope, (doc) => mergeConfigDoc(keysOf(scope), doc, payload));
  });

  return Config.of({ list, get, read, set, unset, write });
});

export const layer = Layer.effect(Config, make);
