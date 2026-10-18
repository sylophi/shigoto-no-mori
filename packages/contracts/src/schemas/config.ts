import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import { isSafeRelPath } from "../predicates/relPath.ts";
import { TERMINAL_IDS } from "./launchers.ts";
import { loose } from "./loose.ts";
import { ProjectScopedPayloadSchema } from "./payloads.ts";
import {
  CustomPortSchema,
  MAX_CUSTOM_PORTS,
  PortNumberSchema,
} from "./ports.ts";
import { ProjectSortModeSchema, SidebarViewSchema } from "./project.ts";
import { MergeMethodSchema } from "./pullRequest.ts";
import { strict } from "./strict.ts";

const ThemeSchema = Schema.Literals(["light", "dark", "system"]);
export type Theme = typeof ThemeSchema.Type;

export const LIGHT_THEME_IDS = [
  "snow",
  "meadow",
  "cream",
  "latte",
  "latte-sage",
  "latte-mocha",
  "sky",
  "sakura",
] as const;
export const DARK_THEME_IDS = [
  "charcoal",
  "forest",
  "wood",
  "cocoa",
  "midnight",
  "yozakura",
] as const;
const LightThemeSchema = Schema.Literals(LIGHT_THEME_IDS);
const DarkThemeSchema = Schema.Literals(DARK_THEME_IDS);
export type LightTheme = typeof LightThemeSchema.Type;
export type DarkTheme = typeof DarkThemeSchema.Type;
const ThemeRotationSchema = Schema.Literals([
  "launch",
  "hourly",
  "daily",
  "weekly",
]);
export type ThemeRotation = typeof ThemeRotationSchema.Type;

const LauncherCommandSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  label: Schema.NonEmptyString,
  command: Schema.NonEmptyString,
});
export type LauncherCommand = typeof LauncherCommandSchema.Type;
export const isLauncherCommand = Schema.is(LauncherCommandSchema);

// Files carried from the primary checkout into new worktrees: `symlink`
// keeps state shared, `copy` snapshots.
const CarryOverPathSchema = Schema.NonEmptyString.check(
  Schema.makeFilter(
    (path: string) =>
      isSafeRelPath(path) || "Path must stay within the project root",
  ),
);
const CarryOverEntrySchema = Schema.Struct({
  path: CarryOverPathSchema,
  mode: Schema.Literals(["copy", "symlink"]),
});
export type CarryOverEntry = typeof CarryOverEntrySchema.Type;
export const isCarryOverEntry = Schema.is(CarryOverEntrySchema);

// - managed-root: <dataDir>/wt/<projectName>/<worktreeName>, the default
// - in-project: <projectPath>/.shigomori/wt/<worktreeName>, inside the
//   primary, so tools that walk up to a workspace root (Turbopack) accept
//   carried-over symlinked node_modules
// - custom: <customWorktreePath>/<worktreeName>, which can collide with
//   other repos
export const WorktreeLayoutSchema = Schema.Literals([
  "managed-root",
  "in-project",
  "custom",
]);
export type WorktreeLayout = typeof WorktreeLayoutSchema.Type;

// Strips keys it does not model: it is also the write input, so a key a
// client invents is dropped at the boundary. Reads use the Stored variant.
export const ShigomoriConfigSchema = Schema.Struct({
  scripts: Schema.optional(
    Schema.Struct({
      setup: Schema.optional(Schema.String).annotateKey({
        description: "Runs after creating a worktree",
      }),
      teardown: Schema.optional(Schema.String).annotateKey({
        description: "Runs before removing a worktree",
      }),
    }),
  ),
  launchers: Schema.optional(Schema.Array(LauncherCommandSchema)).annotateKey({
    description: "Per-project launchers (`launcher` verbs)",
  }),
  portBase: Schema.optional(
    Schema.Int.check(Schema.isGreaterThan(0)),
  ).annotateKey({
    description: "port-pool base port",
  }),
  defaultBranch: Schema.NonEmptyString.annotateKey({
    description: "Branch new worktrees fork from (required)",
  }),
  carryOver: Schema.optional(Schema.Array(CarryOverEntrySchema)).annotateKey({
    description: "Files carried into new worktrees (`carryover` verbs)",
  }),
  // Absent = honored.
  useWorktreeInclude: Schema.optional(Schema.Boolean).annotateKey({
    description: "Honor the repo's .worktreeinclude file",
  }),
  worktreeLayout: Schema.optional(WorktreeLayoutSchema).annotateKey({
    description: "Where managed worktrees live",
  }),
  customWorktreePath: Schema.optional(Schema.String).annotateKey({
    description: "Absolute base dir for the custom layout",
  }),
  lastMergeMethod: Schema.optional(MergeMethodSchema).annotateKey({
    description: "Preferred PR merge method",
  }),
  showPrimaryInInbox: Schema.optional(Schema.Boolean).annotateKey({
    description: "List the primary checkout in the inbox view",
  }),
});
export type ShigomoriConfig = typeof ShigomoriConfigSchema.Type;

// In a module of its own, so the layout math can import it without the
// schema library.
export { PROJECT_CONFIG_DEFAULTS } from "./projectConfigDefaults.ts";

// Seen through an optional or nullable union; null for a node that isn't
// a struct.
function structFieldsOf(
  ast: SchemaAST.AST,
): ReadonlyArray<SchemaAST.PropertySignature> | null {
  if (SchemaAST.isUnion(ast)) {
    const members = ast.types.filter(
      (member) => !SchemaAST.isUndefined(member) && !SchemaAST.isNull(member),
    );
    return members.length === 1 && members[0] !== undefined
      ? structFieldsOf(members[0])
      : null;
  }
  return SchemaAST.isObjects(ast) && ast.indexSignatures.length === 0
    ? ast.propertySignatures
    : null;
}

// Every leaf field a schema models, by its key path (["scripts", "setup"]).
export function modeledKeyFields(
  schema: Schema.Top,
): Array<{ path: string[]; ast: SchemaAST.AST }> {
  return walkKeyFields(structFieldsOf(schema.ast) ?? [], []);
}

export function keyDescriptions(schema: Schema.Top): Record<string, string> {
  return Object.fromEntries(
    modeledKeyFields(schema).map(({ path, ast }) => [
      path.join("."),
      String(ast.context?.annotations?.["description"] ?? ""),
    ]),
  );
}

export function modeledKeyPaths(schema: Schema.Top): string[][] {
  return modeledKeyFields(schema).map(({ path }) => path);
}

function walkKeyFields(
  fields: ReadonlyArray<SchemaAST.PropertySignature>,
  prefix: string[],
): Array<{ path: string[]; ast: SchemaAST.AST }> {
  return fields.flatMap((field) => {
    const path = prefix.concat(String(field.name));
    const nested = structFieldsOf(field.type);
    return nested ? walkKeyFields(nested, path) : [{ path, ast: field.type }];
  });
}

// Loose, so a key a newer build left in the store isn't stripped. A write
// needn't carry it back: the engine merges a write into the stored
// document.
export const StoredShigomoriConfigSchema = loose(ShigomoriConfigSchema);

// The repo's .worktreeinclude (Claude Code's convention: gitignore-syntax
// patterns whose ignored matches are copied into new worktrees).
export const WorktreeIncludeStatusSchema = Schema.Struct({
  fileExists: Schema.Boolean,
  // Matched and gitignored, in git's shape (an ignored directory keeps
  // its trailing slash), as creation sees them. Empty when resolution
  // fails.
  matchedPaths: Schema.Array(Schema.String),
});
export type WorktreeIncludeStatus = typeof WorktreeIncludeStatusSchema.Type;

const isCarryOverPath = Schema.is(CarryOverPathSchema);

export const CarryOverListingPayloadSchema = Schema.Struct({
  ...ProjectScopedPayloadSchema.fields,
  // "" for the root: one string rather than a union of two, which a
  // binary codec could not tell apart.
  relative: Schema.String.check(
    Schema.makeFilter(
      (relative) => relative === "" || isCarryOverPath(relative),
      { expected: 'a root-relative path, or "" for the root' },
    ),
  ),
  // Also call a folder ignored when a rule names it though it holds a
  // force-added file (what a mirror leaves out; carry-over wants git's
  // own verdict).
  ruleIgnored: Schema.optional(Schema.Boolean),
});

// One name in the browsed folder, across checkouts. `worktrees` names the
// non-primary checkouts holding it.
export const CarryOverCandidateSchema = Schema.Struct({
  name: Schema.String,
  isDirectory: Schema.Boolean,
  ignored: Schema.Boolean,
  inPrimary: Schema.Boolean,
  worktrees: Schema.Array(Schema.String),
});
export type CarryOverCandidate = typeof CarryOverCandidateSchema.Type;

export const CarryOverStatsPayloadSchema = Schema.Struct({
  ...ProjectScopedPayloadSchema.fields,
  paths: Schema.Array(CarryOverPathSchema),
});

export const CarryOverStatSchema = Schema.Struct({
  isDirectory: Schema.Boolean,
  inPrimary: Schema.Boolean,
  worktrees: Schema.Array(Schema.String),
});
export type CarryOverStat = typeof CarryOverStatSchema.Type;

// describedAt orders a mirror's describes (on the epoch's scale, not a
// date), so its two sides keep the later pair.
const WorktreeDescriptionSchema = Schema.Struct({
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  describedAt: Schema.optional(Schema.Natural),
});
export type WorktreeDescription = typeof WorktreeDescriptionSchema.Type;

// Kept for managed worktrees only.
export const ShigomoriWorktreeDataSchema = Schema.Struct({
  ...WorktreeDescriptionSchema.fields,
  // Ports the user added beside port-pool's.
  ports: Schema.optional(
    Schema.Array(CustomPortSchema).check(Schema.isMaxLength(MAX_CUSTOM_PORTS)),
  ),
});
export type ShigomoriWorktreeData = typeof ShigomoriWorktreeDataSchema.Type;

// Per-device config: what this machine does, read by the host and the
// CLI. How a window looks is ClientConfigSchema. Reads use the loose
// Stored variant: an imported v2 document can still carry client keys.
const GlobalConfigSchema = Schema.Struct({
  launchers: Schema.optional(Schema.Array(LauncherCommandSchema)),
  // Launcher ids (`app:cursor`, `custom:<uuid>`); one that no longer
  // resolves never matches and is harmless to keep.
  hiddenLaunchers: Schema.optional(Schema.Array(Schema.String)),
  launchScripts: Schema.optional(Schema.Boolean),
  terminal: Schema.optional(Schema.Literals(TERMINAL_IDS)),
  // Absent (or null in a patch) opens a file with its default app.
  editor: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
  deleteBranchOnRemove: Schema.optional(Schema.Boolean),
  autoPopulateInstall: Schema.optional(Schema.Boolean),
  autoPullNew: Schema.optional(Schema.Boolean),
  autoPullPrimaryOnly: Schema.optional(Schema.Boolean),
  // Days untouched (no commit, edit, agent session, creation or unshelve)
  // before a managed worktree is shelved. Absent, or null in a patch, is
  // off.
  autoShelveDays: Schema.optional(
    Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  ),
  // Absent reads as off, so an install from before it defaulted on keeps
  // its names; a fresh store is seeded with `true`.
  doubutsuNames: Schema.optional(Schema.Boolean),
  // Names an external worktree laid out as <name>/<repo> (Codex) after its
  // parent folder. Off by default: a worktree that merely shares the
  // repo's folder name would take whatever folder it sits in.
  codexWorktreeNames: Schema.optional(Schema.Boolean),
  // Managed worktrees of a project on an external drive go on that drive
  // (<volume>/<dataDirName>/wt/…). Ones made before the switch stay until
  // moved.
  managedOnProjectDrive: Schema.optional(Schema.Boolean),
  portPool: Schema.optional(Schema.Boolean),
  terrier: Schema.optional(Schema.Boolean),
  githubCli: Schema.optional(Schema.Boolean),
  // When false, this device runs no direct listener and isn't advertised
  // (its own dials are unaffected). Absent = on. `sm config` only.
  directConnections: Schema.optional(Schema.Boolean),
  // When false, the link refuses every peer call and pushes nothing,
  // except for the mirrors this device asked for. Absent = on. Never in
  // the Settings patch, so no peer can write it.
  shareWithDevices: Schema.optional(Schema.Boolean),
  // For a cloudflared not on PATH. `sm config` only.
  cloudflaredPath: Schema.optional(Schema.String),
});
export type GlobalConfig = typeof GlobalConfigSchema.Type;

export const StoredGlobalConfigSchema = loose(GlobalConfigSchema);

// What the Settings form writes, a peer's included. Strict, so no
// unmanaged key (directConnections, cloudflaredPath) can ride a write; a
// new managed setting must be named here and in DEVICE_SETTINGS_DEFAULTS
// or it can't be written. A patch: only the keys given change.
export const DeviceSettingsPatchSchema = strict(
  Schema.Struct({
    launchers: GlobalConfigSchema.fields.launchers.annotateKey({
      description: "Global custom launchers (`config launcher`)",
    }),
    hiddenLaunchers: GlobalConfigSchema.fields.hiddenLaunchers.annotateKey({
      description: "Hidden launcher ids (via edit or the app)",
    }),
    launchScripts: GlobalConfigSchema.fields.launchScripts.annotateKey({
      description: "Show package scripts in the Launch section",
    }),
    terminal: GlobalConfigSchema.fields.terminal.annotateKey({
      description:
        "Terminal that terminal tools (Claude Code, Neovim, …) open in",
    }),
    editor: GlobalConfigSchema.fields.editor.annotateKey({
      description:
        "Editor files open in (`worktrees edit`, a double click in the app)",
    }),
    deleteBranchOnRemove:
      GlobalConfigSchema.fields.deleteBranchOnRemove.annotateKey({
        description: "Delete the branch when removing its worktree",
      }),
    autoPopulateInstall:
      GlobalConfigSchema.fields.autoPopulateInstall.annotateKey({
        description: "Seed new projects' setup script with `<pm> install`",
      }),
    autoPullNew: GlobalConfigSchema.fields.autoPullNew.annotateKey({
      description:
        "Start new worktrees (and added projects' primaries) with auto-pull on",
    }),
    autoPullPrimaryOnly:
      GlobalConfigSchema.fields.autoPullPrimaryOnly.annotateKey({
        description: "autoPullNew applies to added projects' primaries only",
      }),
    autoShelveDays: GlobalConfigSchema.fields.autoShelveDays.annotateKey({
      description: "Shelve worktrees untouched for this many days",
    }),
    doubutsuNames: GlobalConfigSchema.fields.doubutsuNames.annotateKey({
      description:
        "Name new worktrees after Animal Crossing characters (on for new installs)",
    }),
    codexWorktreeNames:
      GlobalConfigSchema.fields.codexWorktreeNames.annotateKey({
        description:
          "Name Codex-style <name>/<repo> worktrees by their parent folder",
      }),
    managedOnProjectDrive:
      GlobalConfigSchema.fields.managedOnProjectDrive.annotateKey({
        description:
          "Keep managed worktrees on the project's drive when it is an external one",
      }),
    portPool: GlobalConfigSchema.fields.portPool.annotateKey({
      description: "Provision/release port-pool ports with worktrees",
    }),
    terrier: GlobalConfigSchema.fields.terrier.annotateKey({
      description: "List terrier-registered repos as projects",
    }),
    githubCli: GlobalConfigSchema.fields.githubCli.annotateKey({
      description: "GitHub CLI integration",
    }),
  }),
);
export type DeviceSettingsPatch = typeof DeviceSettingsPatchSchema.Type;

export const WriteDeviceSettingsPayloadSchema = Schema.Struct({
  patch: DeviceSettingsPatchSchema,
});

// The value of an absent key. A key written equal to its default is
// stored as absent.
export const DEVICE_SETTINGS_DEFAULTS: Required<DeviceSettingsPatch> = {
  launchers: [],
  hiddenLaunchers: [],
  launchScripts: true,
  terminal: "terminal",
  editor: null,
  deleteBranchOnRemove: true,
  autoPopulateInstall: false,
  autoPullNew: false,
  autoPullPrimaryOnly: false,
  autoShelveDays: null,
  doubutsuNames: false,
  codexWorktreeNames: false,
  managedOnProjectDrive: false,
  portPool: false,
  terrier: false,
  githubCli: true,
};

// How this app instance looks, owned by the main process; the CLI never
// reads it. Must not become strict: a newer build's key has to pass
// through.
export const ClientConfigSchema = Schema.Struct({
  theme: Schema.optional(ThemeSchema),
  // Absent = on. Mirrored to localStorage so startup paints without a
  // flash, as are the palettes.
  doubutsu: Schema.optional(Schema.Boolean),
  lightTheme: Schema.optional(LightThemeSchema),
  darkTheme: Schema.optional(DarkThemeSchema),
  // The stamp is when the picks last changed, which timed rotations
  // count from.
  themeRotation: Schema.optional(ThemeRotationSchema),
  themeRotatedAt: Schema.optional(Schema.Finite),
  // Desktop only: it needs villager data in this device's data dir.
  villageLife: Schema.optional(Schema.Boolean),
  // Absent = on.
  villageNews: Schema.optional(Schema.Boolean),
  markTerrierProjects: Schema.optional(Schema.Boolean),
  // Absent = on.
  showDeviceBadges: Schema.optional(Schema.Boolean),
  allowAgentWorking: Schema.optional(Schema.Boolean),
  // Absent = on.
  markAgentsWaiting: Schema.optional(Schema.Boolean),
  // Waiting: absent = on. Done: absent = off.
  notifyAgentWaiting: Schema.optional(Schema.Boolean),
  notifyAgentDone: Schema.optional(Schema.Boolean),
  inlineWorktrees: Schema.optional(Schema.Boolean),
  // Absent = on.
  pauseAnimationsOnBattery: Schema.optional(Schema.Boolean),
  // The login item and the relaunch after a crash. Read through
  // keepReachableOn (absent = on).
  keepReachable: Schema.optional(Schema.Boolean),
  // Local port by `${deviceId}:${remotePort}`, a forward's identity. Only
  // ports that differ from the remote one are stored.
  forwardLocalPorts: Schema.optional(
    Schema.Record(Schema.String, PortNumberSchema),
  ),
  // Legacy, read only by the one-time move into the shared settings
  // (quickCreateDevice), which clears it.
  quickCreateDevices: Schema.optional(
    Schema.Record(Schema.String, Schema.String),
  ),
  sidebarView: Schema.optional(SidebarViewSchema),
  projectsSort: Schema.optional(ProjectSortModeSchema),
  // Absent = on.
  groupProjectsByOwner: Schema.optional(Schema.Boolean),
  // By group key (projectGroupKey).
  collapsedProjects: Schema.optional(Schema.Array(Schema.String)),
  // By keymap action id, as "Mod+Shift+N"; only chords that differ from
  // the default. One that doesn't read, or an unknown id, is ignored.
  keybindings: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type ClientConfig = typeof ClientConfigSchema.Type;

// The group key of a peer's project with no repo identity. The prefix
// can't collide with a repo identity (`root:`, `remote:`) or a local
// project id (never holding a `/`).
export const peerProjectKey = (deviceId: string, projectId: string) =>
  `device:${deviceId}/${projectId}`;

// What a device leaving the account drops: these name the old account's
// devices or repos, which a later account must not inherit.
export function withoutPeerState(config: ClientConfig): ClientConfig {
  const {
    forwardLocalPorts: _forwardLocalPorts,
    quickCreateDevices: _quickCreateDevices,
    collapsedProjects: _collapsedProjects,
    ...rest
  } = config;
  return rest;
}

export function keepReachableOn(
  config: Pick<ClientConfig, "keepReachable">,
): boolean {
  return config.keepReachable !== false;
}

export const StoredClientConfigSchema = loose(ClientConfigSchema);

// Applied over the config as it stands, so a window never overwrites a
// key another window changed meanwhile.
export const PatchClientConfigPayloadSchema = Schema.Struct({
  set: ClientConfigSchema,
  clear: Schema.Array(
    Schema.Literals(
      Object.keys(ClientConfigSchema.fields) as [
        keyof typeof ClientConfigSchema.fields,
        ...(keyof typeof ClientConfigSchema.fields)[],
      ],
    ),
  ),
});

export const WriteShigomoriPayloadSchema = Schema.Struct({
  ...ProjectScopedPayloadSchema.fields,
  config: ShigomoriConfigSchema,
});

// worktreeIdFromPath's shape. Held exactly, since the worktree data
// payloads key the engine's rows by it without a pass through git's list.
export const WorktreeIdSchema = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{12}$/),
);

export const ReadWorktreeDataPayloadSchema = Schema.Struct({
  ...ProjectScopedPayloadSchema.fields,
  worktreeId: WorktreeIdSchema,
});

// The custom ports only: the title and description have their own writer.
export const WriteWorktreeDataPayloadSchema = Schema.Struct({
  ...ReadWorktreeDataPayloadSchema.fields,
  data: Schema.Struct({ ports: ShigomoriWorktreeDataSchema.fields.ports }),
});

export const WriteWorktreeDescriptionPayloadSchema = Schema.Struct({
  ...ReadWorktreeDataPayloadSchema.fields,
  description: WorktreeDescriptionSchema,
});

export const PreviewThemePayloadSchema = Schema.Struct({
  theme: ThemeSchema,
});

export const NotifyPayloadSchema = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  route: Schema.String,
});
