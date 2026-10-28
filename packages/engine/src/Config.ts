import {
  DEVICE_CONFIG_DEFAULTS,
  DEVICE_SETTINGS_DEFAULTS,
  DeviceConfigKeysSchema,
  type DeviceSettingsPatch,
  DeviceSettingsPatchSchema,
  modeledKeyFields,
  PROJECT_CONFIG_DEFAULTS,
  type ProjectSettingsPatch,
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
  savedConfigDoc,
  settingKeys,
} from "./configDoc.ts";
import catalog from "./data/launcher-catalog.json" with { type: "json" };
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
  // The command line was what was wrong.
  get usage(): boolean {
    return true;
  }

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
  // The command line was what was wrong.
  get usage(): boolean {
    return true;
  }

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
// is edited with `sm config edit` or in the app.
export class StructuredConfigKey extends Schema.TaggedError<StructuredConfigKey>()(
  "StructuredConfigKey",
  {
    key: Schema.String,
    verbs: Schema.String,
    orTheApp: Schema.Boolean,
    binaryName: Schema.String,
  },
) {
  // The command line was what was wrong.
  get usage(): boolean {
    return true;
  }

  override get message(): string {
    const or = this.orTheApp ? " or the app" : "";
    return `${this.key} is structured: use \`${this.binaryName} ${this.verbs}\`${or}.`;
  }
}

// A write asked for over the settings as they were read, which changed
// since (the app's save, another command's).
export class ConfigChangedMeanwhile extends Schema.TaggedError<ConfigChangedMeanwhile>()(
  "ConfigChangedMeanwhile",
  {},
) {
  override get message(): string {
    return "The settings changed meanwhile.";
  }
}

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner).toSorted(([x], [y]) => (x < y ? -1 : 1)),
        )
      : inner,
  );

// Whether two documents hold the same settings, whatever their keys'
// order.
export const sameConfigDoc = (a: unknown, b: unknown): boolean =>
  canonical(a) === canonical(b);

// A project's settings must name its default branch, which a write
// would leave out and git couldn't name. `project` is its name, or its
// id when it has none.
export class MissingDefaultBranch extends Schema.TaggedError<MissingDefaultBranch>()(
  "MissingDefaultBranch",
  {
    projectId: Schema.String,
    project: Schema.String,
    binaryName: Schema.String,
  },
) {
  override get message(): string {
    return `Can't determine ${this.project}'s default branch. Set it first: ${this.binaryName} projects config set defaultBranch <ref> -p ${this.project}`;
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
    // A device setting as it applies: the stored value when it is one
    // of the setting's, else its default.
    readonly device: <K extends keyof DeviceSettingsPatch>(
      key: K,
    ) => Effect.Effect<(typeof DEVICE_SETTINGS_DEFAULTS)[K]>;
    // The app's save of some device settings: each key given set, or
    // removed when it equals its default or is null, the rest kept, in
    // one transaction.
    readonly patch: (
      patch: DeviceSettingsPatch,
    ) => Effect.Effect<void, InvalidConfigDocument>;
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
    // The app's save of a project's settings, a peer's included: each key
    // given set, or removed when null, the rest kept, in one transaction.
    readonly patchProject: (
      scope: Extract<ConfigScope, { readonly kind: "project" }>,
      patch: ProjectSettingsPatch,
    ) => Effect.Effect<void, InvalidConfigDocument | MissingDefaultBranch>;
    // `config edit`'s whole-document save, only over `ifStoredIs`, the
    // settings as they were read: stored as saved, a null deleting its
    // key. The edit shows every stored key, so one the save leaves out
    // was deleted, modeled or not.
    readonly write: (
      scope: ConfigScope,
      payload: ConfigDoc,
      ifStoredIs: ConfigDoc,
    ) => Effect.Effect<
      void,
      InvalidConfigDocument | MissingDefaultBranch | ConfigChangedMeanwhile
    >;
    // The document as stored, changed by `change` and written back in
    // one transaction: the terminal's verbs over the list-valued
    // settings. A project's default branch is filled in from git when
    // the document has none. A change that answers null writes nothing.
    readonly change: (
      scope: ConfigScope,
      change: (doc: ConfigDoc) => ConfigDoc | null,
    ) => Effect.Effect<void, MissingDefaultBranch>;
    // The ids of the projects that have settings stored.
    readonly storedProjectIds: Effect.Effect<ReadonlyArray<string>>;
    // Drops a project's stored settings.
    readonly forgetProject: (projectId: string) => Effect.Effect<void>;
    // Carries a project's stored settings to another id, replacing what
    // that id held.
    readonly rekeyProject: (from: string, to: string) => Effect.Effect<void>;
  }
>()("sm/engine/Config") {}

// The keys in the order the CLI lists them. A key the schema models and
// this list misses is still listed, last.
const deviceKeys = settingKeys(
  modeledKeyFields(DeviceConfigKeysSchema),
  DEVICE_CONFIG_DEFAULTS,
  [
    "launchScripts",
    "deleteBranchOnRemove",
    "autoPopulateInstall",
    "autoPullNew",
    "autoPullPrimaryOnly",
    "autoShelveDays",
    "doubutsuNames",
    "codexWorktreeNames",
    "managedOnProjectDrive",
    "portPool",
    "terrier",
    "githubCli",
    "launchers",
    "hiddenLaunchers",
    "terminal",
    "editor",
    "directConnections",
    "cloudflaredPath",
  ],
  {
    launchers: {
      verbs: "config launcher add/rm",
      entryProblem: launcherProblem,
    },
    hiddenLaunchers: { entryProblem: launcherIdProblem },
  },
);
// `sm config` lists the terminals by id, sorted, where Settings lists
// them in its own order. The editor names a catalog tool marked
// editor, which the contract's string can't say. `set` holds it to
// those, and a stored id the catalog no longer lists still reads and
// writes back.
for (const key of deviceKeys) {
  if (key.name === "terminal") {
    Object.assign(key, { choices: key.choices.toSorted() });
  }
  if (key.name === "editor") {
    Object.assign(key, {
      choices: catalog
        .filter((app) => app.editor === true)
        .map((app) => app.id)
        .toSorted(),
    });
  }
}

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

// A project's settings as they apply: none until its default branch is
// set, a blank one counting as unset.
export const projectSettingsOf = (doc: ConfigDoc | null) => {
  const branch = doc?.["defaultBranch"];
  return doc !== null && typeof branch === "string" && branch.trim() !== ""
    ? { settings: doc, defaultBranch: branch }
    : { settings: null, defaultBranch: undefined };
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
      if (key.choices.length > 0 && !key.choices.includes(raw))
        return invalid("enum");
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
  // `.shigomori/` from the primary's git status. A change that answers
  // false changes nothing, and nothing is written or filled in.
  const update = (
    scope: ConfigScope,
    change: (doc: ConfigDoc) => void | false,
  ) => {
    // One try at the write. Without a default branch it fails, unless
    // git named one to fill in.
    const attempt = (fallbackBranch: Option.Option<string>) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const before = (yield* load(scope)) ?? {};
          const next = structuredClone(before);
          if (change(next) === false) return false;
          if (scope.kind === "project" && missingBranch(next)) {
            if (Option.isNone(fallbackBranch)) {
              const [row] = yield* sql<{ readonly name: string }>`
                SELECT name FROM projects WHERE id = ${scope.projectId}`;
              return yield* new MissingDefaultBranch({
                projectId: scope.projectId,
                project: row?.name ?? scope.projectId,
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

  const device = Effect.fn("Config.device")(function* <
    K extends keyof DeviceSettingsPatch,
  >(key: K) {
    const doc = yield* load({ kind: "device" });
    const field: Schema.Decoder<unknown> =
      DeviceSettingsPatchSchema.struct.fields[key];
    const stored = Schema.decodeUnknownOption(field)(doc?.[key]);
    return (Option.getOrUndefined(stored) ??
      DEVICE_SETTINGS_DEFAULTS[key]) as (typeof DEVICE_SETTINGS_DEFAULTS)[K];
  });

  const patch = Effect.fn("Config.patch")(function* (
    changes: DeviceSettingsPatch,
  ) {
    const given = Object.entries(changes).filter(
      ([, value]) => value !== undefined,
    );
    const problem = documentProblem(
      keysOf({ kind: "device" }).filter(({ name }) =>
        given.some(([key]) => key === name),
      ),
      Object.fromEntries(given),
    );
    if (problem !== undefined) {
      return yield* new InvalidConfigDocument({ problem });
    }
    yield* update({ kind: "device" }, (doc) => {
      for (const [key, value] of given) {
        if (
          value === null ||
          JSON.stringify(value) ===
            JSON.stringify(
              DEVICE_SETTINGS_DEFAULTS[key as keyof DeviceSettingsPatch],
            )
        ) {
          docDelete(doc, key);
        } else {
          docSet(doc, key, value);
        }
      }
    }).pipe(
      Effect.catchTags({
        MissingDefaultBranch: (missing) => Effect.die(missing),
      }),
    );
  });

  const patchProject = Effect.fn("Config.patchProject")(function* (
    scope: Extract<ConfigScope, { readonly kind: "project" }>,
    changes: ProjectSettingsPatch,
  ) {
    const given = Object.entries(changes).filter(
      ([, value]) => value !== undefined,
    );
    const values: ConfigDoc = {};
    for (const [key, value] of given) {
      if (value !== null) docSet(values, key, value);
    }
    const problem = documentProblem(
      projectKeys.filter(({ name }) =>
        given.some(([key, value]) => key === name && value !== null),
      ),
      values,
    );
    if (problem !== undefined) {
      return yield* new InvalidConfigDocument({ problem });
    }
    yield* update(scope, (doc) => {
      for (const [key, value] of given) {
        if (value === null) docDelete(doc, key);
        else docSet(doc, key, value);
      }
    });
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
    ifStoredIs: ConfigDoc,
  ) {
    const problem = documentProblem(keysOf(scope), payload);
    if (problem !== undefined) {
      return yield* new InvalidConfigDocument({ problem });
    }
    // Compared in the write's own read, so a save landing between a
    // read and the write isn't written away.
    let stale = false;
    yield* update(scope, (doc) => {
      if (!sameConfigDoc(doc, ifStoredIs)) {
        stale = true;
        return false;
      }
      for (const key of Object.keys(doc)) delete doc[key];
      Object.assign(doc, savedConfigDoc(payload));
    });
    if (stale) return yield* new ConfigChangedMeanwhile();
  });

  const change = Effect.fn("Config.change")(function* (
    scope: ConfigScope,
    changed: (doc: ConfigDoc) => ConfigDoc | null,
  ) {
    yield* update(scope, (doc) => {
      const next = changed(structuredClone(doc));
      if (next === null) return false;
      for (const key of Object.keys(doc)) delete doc[key];
      Object.assign(doc, next);
    });
  });

  const storedProjectIds = sql<{ project_id: string }>`
    SELECT DISTINCT project_id FROM project_config`.pipe(
    Effect.map((rows) => rows.map(({ project_id }) => project_id)),
    Effect.orDie,
    Effect.withSpan("Config.storedProjectIds"),
  );

  return Config.of({
    list,
    get,
    read,
    device,
    patch,
    patchProject,
    set,
    unset,
    write,
    change,
    storedProjectIds,
    forgetProject: Effect.fn("Config.forgetProject")(function* (
      projectId: string,
    ) {
      yield* sql`DELETE FROM project_config WHERE project_id = ${projectId}`;
    }, Effect.orDie),
    rekeyProject: Effect.fn("Config.rekeyProject")(function* (
      from: string,
      to: string,
    ) {
      yield* sql`DELETE FROM project_config WHERE project_id = ${to}`;
      yield* sql`UPDATE project_config SET project_id = ${to}
        WHERE project_id = ${from}`;
    }, Effect.orDie),
  });
});

export const layer = Layer.effect(Config, make);
