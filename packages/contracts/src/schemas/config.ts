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

// The doubutsu palettes, one list per appearance. In packages/ui/src/styles,
// doubutsu.css carries the defaults (cream, charcoal) and palettes.css the
// rest. The catalog in packages/ui/src/lib/themes.ts names them and pairs
// each light over its dark twin.
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

const LauncherCommandSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  label: Schema.NonEmptyString,
  command: Schema.NonEmptyString,
});
export type LauncherCommand = typeof LauncherCommandSchema.Type;

// Files/folders to carry over from the primary checkout into newly-created
// worktrees. `path` is relative to the project root; gitignored entries are
// the expected source. `symlink` keeps state shared; `copy` snapshots.
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

// Where shigomori's managed worktrees for this project live on disk.
// - managed-root: <dataDir>/wt/<projectName>/<worktreeName>
//   (default; one place for every project's worktrees, easy to nuke.
//   The device's managedOnProjectDrive setting moves it onto the
//   drive of a project that sits on an external one)
// - in-project: <projectPath>/.shigomori/wt/<worktreeName>
//   (sits inside the primary; lets tools that walk up to a workspace
//   root, like Turbopack, accept symlinked node_modules from carry-over)
// - custom: <customWorktreePath>/<worktreeName>
//   (escape hatch, not recommended, since it can collide with other
//   repos and complicates external-vs-managed detection)
const WorktreeLayoutSchema = Schema.Literals([
  "managed-root",
  "in-project",
  "custom",
]);
export type WorktreeLayout = typeof WorktreeLayoutSchema.Type;

// Per-project config, kept in the store (the engine's Config) and
// managed by the app, not committed to the user's repo.
// Drops keys it does not model. It doubles as the shigomori:write IPC
// input, so a key the renderer invents is dropped at the boundary
// instead of being persisted into the project's settings. Reads use the
// Stored variant below.
export const ShigomoriConfigSchema = Schema.Struct({
  scripts: Schema.optional(
    Schema.Struct({
      setup: Schema.optional(Schema.String),
      teardown: Schema.optional(Schema.String),
    }),
  ),
  launchers: Schema.optional(Schema.Array(LauncherCommandSchema)),
  portBase: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  defaultBranch: Schema.NonEmptyString,
  carryOver: Schema.optional(Schema.Array(CarryOverEntrySchema)),
  // When false, the repo's .worktreeinclude file is ignored at worktree
  // creation. Absent = enabled (the integration is opt-out).
  useWorktreeInclude: Schema.optional(Schema.Boolean),
  worktreeLayout: Schema.optional(WorktreeLayoutSchema),
  // Absolute path; only meaningful when worktreeLayout === "custom".
  customWorktreePath: Schema.optional(Schema.String),
  // Last merge method picked for this project's PRs. Drives the split-
  // button's primary action so each repo remembers its house style.
  // Falls back to whatever the repo allows when the saved value is
  // disabled at GitHub.
  lastMergeMethod: Schema.optional(MergeMethodSchema),
  // When true, the inbox view lists this project's primary checkout
  // alongside its worktrees (always live, never shelved or merged).
  // Per project because the primary means different things in
  // different repos: in some it's a place you work, in most it's just
  // the root. Off by default. Absent = hidden.
  showPrimaryInInbox: Schema.optional(Schema.Boolean),
});
export type ShigomoriConfig = typeof ShigomoriConfigSchema.Type;

// In a module of its own, which the layout math can import without the
// schema library.
export { PROJECT_CONFIG_DEFAULTS } from "./projectConfigDefaults.ts";

// The fields an object node models, seen through an optional or
// nullable union, or null for a node that isn't a struct (a record, an
// array, a scalar).
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

// Every field a schema models, as the keys down to it, nested objects
// field by field (["scripts", "setup"]), with the field's own schema
// node. The engine's settings read their kinds from it.
export function modeledKeyFields(
  schema: Schema.Top,
): Array<{ path: string[]; ast: SchemaAST.AST }> {
  return walkKeyFields(structFieldsOf(schema.ast) ?? [], []);
}

// The paths alone, which the host's project write walks.
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

// The same document as read from the store, where a newer version may
// have left keys this build doesn't model. Loose so the app doesn't
// strip them out from under the user. They never have to ride back out
// in a write payload: the engine's config write merges into the stored
// document rather than replacing it, so a key the payload doesn't
// mention stays put.
export const StoredShigomoriConfigSchema = loose(ShigomoriConfigSchema);

// Snapshot of the repo's .worktreeinclude file (Claude Code convention:
// gitignore-syntax patterns whose gitignored matches are copied into new
// worktrees). Read-only from the app's side; the file belongs to the repo.
export const WorktreeIncludeStatusSchema = Schema.Struct({
  fileExists: Schema.Boolean,
  // Paths the file's patterns currently resolve to (matched AND
  // gitignored), in git's raw shape: fully-ignored directories keep
  // their trailing slash. Matches what creation-time reconciliation
  // sees, so the UI's covered badge and the actual auto-removal agree.
  // Empty when resolution fails.
  matchedPaths: Schema.Array(Schema.String),
});
export type WorktreeIncludeStatus = typeof WorktreeIncludeStatusSchema.Type;

// The carry-over picker reads a union of the primary and every
// worktree: entries are root-relative, so any checkout can hold them
// and the engine copies from whichever has the file at creation.
const isCarryOverPath = Schema.is(CarryOverPathSchema);

export const CarryOverListingPayloadSchema = Schema.Struct({
  ...ProjectScopedPayloadSchema.fields,
  // Folder being browsed, root-relative, with "" for the root. One
  // string rather than a union of two, which a binary codec could not
  // tell apart.
  relative: Schema.String.check(
    Schema.makeFilter(
      (relative) => relative === "" || isCarryOverPath(relative),
      { expected: 'a root-relative path, or "" for the root' },
    ),
  ),
  // Also call a folder ignored when a rule names it though it holds a
  // force-added file (what a mirror leaves out, where carry-over needs
  // git's own verdict). A peer from before the flag drops it and
  // answers without.
  ruleIgnored: Schema.optional(Schema.Boolean),
});

// One name in the browsed folder, across checkouts. `ignored` is judged
// by the gitignore of a checkout that has it. `worktrees` names the
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

// Where a configured entry currently exists. Missing everywhere when
// neither `inPrimary` nor any `worktrees`.
export const CarryOverStatSchema = Schema.Struct({
  isDirectory: Schema.Boolean,
  inPrimary: Schema.Boolean,
  worktrees: Schema.Array(Schema.String),
});
export type CarryOverStat = typeof CarryOverStatSchema.Type;

// A worktree's title and description: what its work is, set by `sm
// describe` until a pull request's title and
// body take over. describedAt (epoch ms) is when they were last set,
// so a mirror's two sides keep the newer pair. Only `sm describe` and
// the moves between devices write them (writeWorktreeDescription).
const WorktreeDescriptionSchema = Schema.Struct({
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  describedAt: Schema.optional(Schema.Natural),
});
export type WorktreeDescription = typeof WorktreeDescriptionSchema.Type;

// Per-worktree persistent data. Only kept for shigomori-managed worktrees;
// external worktrees deliberately have no stored state.
export const ShigomoriWorktreeDataSchema = Schema.Struct({
  ...WorktreeDescriptionSchema.fields,
  // Ports the user added beside port-pool's (see schemas/ports.ts).
  // The renderer's one key here, written through useWorktreeDataWrite;
  // the host merges it into the stored document under its lock.
  ports: Schema.optional(
    Schema.Array(CustomPortSchema).check(Schema.isMaxLength(MAX_CUSTOM_PORTS)),
  ),
});
export type ShigomoriWorktreeData = typeof ShigomoriWorktreeDataSchema.Type;

// Global, per-device config, kept in the store (the engine's Config). Holds
// preferences that span every project: custom launchers the user wants
// everywhere (claude, tmux, an editor command, etc.), and room for future
// settings.
// Device config only: every key here gates what this machine can do,
// so both the host and the CLI read it. How the app instance looks
// (theme, palettes) is client config and lives in ClientConfigSchema
// below.
// Reads use the loose Stored variant below: an imported v2 document can
// still carry client keys (and a newer build's keys) in the stored
// settings, and those have to pass through unrejected.
const GlobalConfigSchema = Schema.Struct({
  launchers: Schema.optional(Schema.Array(LauncherCommandSchema)),
  // Launcher entry ids (`app:cursor`, `web:github`, `custom:<uuid>`) the
  // user has switched off, so they're skipped when building a project's
  // launcher row, and therefore also absent from the File menu's
  // ⌘1..⌘9, which mirrors the row. Everything is shown by default;
  // absent = nothing hidden. Ids that no longer resolve (an app the user
  // uninstalled, a deleted custom tool) simply never match and are
  // harmless to keep.
  hiddenLaunchers: Schema.optional(Schema.Array(Schema.String)),
  // When true, the Launch section carries a second row of the worktree's
  // top package.json scripts, as many as fit on one line, ordered by the
  // project's script sort. On by default; absent = on, explicit `false` is
  // the opt-out.
  launchScripts: Schema.optional(Schema.Boolean),
  // The terminal app terminal tools (Claude Code, Neovim, lazygit, …)
  // open in, a launcher catalog id. Absent = Terminal. The
  // engine's Open.ts launches them.
  terminal: Schema.optional(Schema.Literals(TERMINAL_IDS)),
  // When false, deleting a worktree keeps its checked-out local branch
  // (deletion is skipped anyway if the branch is the primary's or in
  // use by another worktree). ON by default. Unset means delete
  // (Worktrees.remove in the engine, which every removal runs through).
  deleteBranchOnRemove: Schema.optional(Schema.Boolean),
  // When true, adding a project with a package.json seeds its setup
  // script with `<detected-pm> install`. Only fires at project-add
  // time; existing projects are untouched.
  autoPopulateInstall: Schema.optional(Schema.Boolean),
  // When true, a new worktree, and the primary checkout of a newly
  // added project, start out with auto-pull on (the mark `sm worktrees
  // autopull` sets). Only fires at create and add time, in the engine. Existing
  // worktrees keep their footer toggle as they are.
  autoPullNew: Schema.optional(Schema.Boolean),
  // When true, autoPullNew covers only the primary checkout of a newly
  // added project. Nothing on its own.
  autoPullPrimaryOnly: Schema.optional(Schema.Boolean),
  // The idle shelf: a managed worktree nothing has touched for this
  // many days (no commit, edit, agent session, creation or unshelve)
  // goes on the shelf, where working in it brings it back as before.
  // Kept by the engine's full listing (Worktrees.ts, shelf.ts). Absent
  // is off, and a patch turns it off with null.
  autoShelveDays: Schema.optional(
    Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  ),
  // When true, auto-picked worktree names are Animal Crossing villager
  // and character names, the ones with a face on Nookipedia
  // (packages/engine/src/data/doubutsu-names.json, e.g. `raymond`),
  // instead of adjective + animal pairs (`snug-otter`). Picked by the
  // engine (names.ts), at create time and for the New Worktree form's
  // pre-pick (`sm worktrees destination`). Absent reads as off, so an
  // install from before it defaulted on keeps its names. A fresh
  // install is seeded with `true` instead (the store's first open,
  // the engine's migrations/importJson.ts).
  doubutsuNames: Schema.optional(Schema.Boolean),
  // When true, an external worktree whose folder is just the repo's
  // name (Codex and other tools lay worktrees out as
  // <worktree-name>/<repo-name>) is named after the folder above it.
  // Off by default: a worktree that merely shares the repo's folder
  // name would take whatever folder it sits in. Applied wherever the
  // engine lists worktrees, the app's rows included.
  codexWorktreeNames: Schema.optional(Schema.Boolean),
  // When true, a project on an external drive keeps its managed-layout
  // worktrees on that drive
  // (<volume>/<dataDirName>/wt/<projectName>/<worktreeName>)
  // instead of under the data dir. Nothing changes for a project on the
  // internal drive, one whose drive already holds the data dir, or one
  // on another layout. Decided by the engine wherever it places a
  // worktree (worktreeBase in worktreeLayout.ts). Worktrees made before the
  // switch stay where they are until the project's Worktree location
  // page moves them. Off by default.
  managedOnProjectDrive: Schema.optional(Schema.Boolean),
  // When true, projects with a valid port-pool.config.json run
  // `port-pool provision` after setup at create and
  // `port-pool release` before teardown at delete.
  portPool: Schema.optional(Schema.Boolean),
  // When true, repos registered in terrier (github.com/dittofleet/terrier)
  // are listed as projects alongside the registry's own. Terrier-sourced
  // projects can't be removed here, only `terrier rm` unregisters them. A
  // path registered in both is an ordinary removable project, and
  // removing its registry entry demotes it back to terrier-sourced. Off by
  // default, and only active while `terrier` is on PATH and `terrier ls
  // --json` answers in the shape the engine's Terrier.ts reads.
  terrier: Schema.optional(Schema.Boolean),
  // When true, GitHub CLI features light up wherever they apply.
  // Activates only when `gh` is on PATH and authenticated. On by
  // default; matches the integration being opt-out rather than opt-in.
  githubCli: Schema.optional(Schema.Boolean),
  // Direct data plane: when false, this device neither runs the direct
  // listener nor is advertised to peers, so it serves no peers at all
  // (its own dials to peers are unaffected). ON by default (absent =
  // enrolled, explicit `false` is the opt-out). Config-only (no
  // Settings UI): toggle with `sm config`.
  directConnections: Schema.optional(Schema.Boolean),
  // Sharing with the account's other devices: when false, this
  // device's link refuses every call they make, reads included, and
  // pushes them nothing, except for the mirrors this device asked for.
  // ON by default (absent = sharing). Set from the account page
  // (sharing:set) or `sm config`, never through the Settings form, so
  // no peer can write it.
  shareWithDevices: Schema.optional(Schema.Boolean),
  // Tunnel endpoints: absolute path to the
  // cloudflared binary, for installs not on PATH. Absent means PATH
  // discovery. A missing binary reads as tunnels off with a typed
  // status, never an error loop. Config-only, like directConnections.
  cloudflaredPath: Schema.optional(Schema.String),
});
export type GlobalConfig = typeof GlobalConfigSchema.Type;

// Read-side counterpart, loose like StoredShigomoriConfigSchema. Also
// the globalConfig:read output, so legacy and newer keys pass through.
export const StoredGlobalConfigSchema = loose(GlobalConfigSchema);

// The device settings the Settings form writes, this machine's and a
// peer's alike: exactly the keys the form manages. STRICT on purpose,
// unlike GlobalConfigSchema: an unknown key REJECTS rather than
// strips, so the schema itself proves that no unmanaged key
// (directConnections, cloudflaredPath, anything legacy) can ride a
// settings write. Patch semantics: every key optional, only provided
// keys change, and the host handler applies them over the stored
// document so everything the patch does not name rides through intact.
// Derived by picking from GlobalConfigSchema rather than respelling the
// field types, so a managed key's shape cannot drift. A NEW managed
// device setting has to be named here and in DEVICE_SETTINGS_DEFAULTS
// below, or the strict reject makes it un-writable.
export const DeviceSettingsPatchSchema = strict(
  Schema.Struct({
    launchers: GlobalConfigSchema.fields.launchers,
    hiddenLaunchers: GlobalConfigSchema.fields.hiddenLaunchers,
    launchScripts: GlobalConfigSchema.fields.launchScripts,
    terminal: GlobalConfigSchema.fields.terminal,
    deleteBranchOnRemove: GlobalConfigSchema.fields.deleteBranchOnRemove,
    autoPopulateInstall: GlobalConfigSchema.fields.autoPopulateInstall,
    autoPullNew: GlobalConfigSchema.fields.autoPullNew,
    autoPullPrimaryOnly: GlobalConfigSchema.fields.autoPullPrimaryOnly,
    autoShelveDays: GlobalConfigSchema.fields.autoShelveDays,
    doubutsuNames: GlobalConfigSchema.fields.doubutsuNames,
    codexWorktreeNames: GlobalConfigSchema.fields.codexWorktreeNames,
    managedOnProjectDrive: GlobalConfigSchema.fields.managedOnProjectDrive,
    portPool: GlobalConfigSchema.fields.portPool,
    terrier: GlobalConfigSchema.fields.terrier,
    githubCli: GlobalConfigSchema.fields.githubCli,
  }),
);
export type DeviceSettingsPatch = typeof DeviceSettingsPatchSchema.Type;

export const WriteDeviceSettingsPayloadSchema = Schema.Struct({
  patch: DeviceSettingsPatchSchema,
});

// The value each device setting takes while its key is absent from
// the stored settings. One table for both ends of the settings write: the form
// decodes a missing key with it (fromConfig in
// renderer/hooks/config/useSettingsSave.ts), and the host's patch
// handler stores a key equal to its default by deleting it, so the
// document stays tidy whichever device saved it. The engine's Config
// reads its defaults from here.
export const DEVICE_SETTINGS_DEFAULTS: Required<DeviceSettingsPatch> = {
  launchers: [],
  hiddenLaunchers: [],
  launchScripts: true,
  terminal: "terminal",
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

// Client config: how this app instance looks, kept in clientConfig.json
// under Electron's userData and owned by the main process alone. The
// CLI never reads or writes it, unlike the device config above.
// Doubles as the clientConfig:write IPC input. A plain struct STRIPS
// unknown keys rather than rejecting them, which drops a key the
// renderer invents at the boundary, and it must not become strict: a
// key from a newer build has to keep passing through unrejected.
export const ClientConfigSchema = Schema.Struct({
  theme: Schema.optional(ThemeSchema),
  // "Animal Crossing" visual mode. Orthogonal to theme: when on, both
  // the light and dark palettes shift to a bolder, color-blocked,
  // Zen-Maru-Gothic-typeset look. On by default (absent = on), explicit
  // `false` is the opt-out back to the v1 look. Mirrored to
  // localStorage so startup paints without a flash.
  doubutsu: Schema.optional(Schema.Boolean),
  // Which doubutsu palette each appearance wears
  // (packages/ui/src/lib/themes.ts), picked separately for light and dark the
  // way most apps offer it. Absent is the default of each list, cream and
  // charcoal. Kept while doubutsu is off, so switching it back on restores
  // the picks. Mirrored to localStorage with the switch.
  lightTheme: Schema.optional(LightThemeSchema),
  darkTheme: Schema.optional(DarkThemeSchema),
  // Past the first run's page (renderer/components/welcome): a project
  // was added there, or this install moved from v2 or had projects
  // before. Absent = not yet, which the shell's first window opens on.
  welcomed: Schema.optional(Schema.Boolean),
  // Village life: the purely visual villager extras on worktrees named
  // after a character, on every device this window shows. Needs the
  // villager data, downloaded into this device's data dir
  // (host/lib/villagers.ts), so only the desktop offers it: a web
  // client has no device of its own. Off by default (absent = off),
  // explicit `true` is the opt-in. Nothing on a device reads it.
  villageLife: Schema.optional(Schema.Boolean),
  // Village news: the toasts villagers send moving in or out
  // (renderer/lib/villagers/moves.ts), under Village life. On by
  // default (absent = on), explicit `false` keeps them quiet.
  villageNews: Schema.optional(Schema.Boolean),
  // Mark the sidebar's terrier-sourced projects (Project.source), the
  // ones the terrier registry lists rather than this app's own, with
  // terrier's paw, on every device this window shows. Off by default
  // (absent = off), explicit `true` is the opt-in.
  markTerrierProjects: Schema.optional(Schema.Boolean),
  // The device badges on the sidebar's rows: the mark of each device a
  // project spans on its header, and of the device a worktree lives on
  // (or is mirrored with) on its row. On by default (absent = on),
  // explicit `false` hides them, on every device this window shows.
  showDeviceBadges: Schema.optional(Schema.Boolean),
  // Shelve worktrees agents are working in: file the worktrees with a
  // working agent session (`sm agents`) on their own folded shelf, on
  // every device this window shows. Off by default (absent = off),
  // explicit `true` is the opt-in.
  allowAgentWorking: Schema.optional(Schema.Boolean),
  // Mark the worktrees whose agent session waits on the user (a
  // permission prompt or a question), on every device this window
  // shows. On by default (absent = on), explicit `false` hides it.
  markAgentsWaiting: Schema.optional(Schema.Boolean),
  // The desktop's notifications about agent sessions, on every device
  // this window shows (renderer/lib/agentWatch.ts): one when a
  // session starts waiting on the user (on by default, absent = on),
  // and one when a turn ends (off by default, absent = off).
  notifyAgentWaiting: Schema.optional(Schema.Boolean),
  notifyAgentDone: Schema.optional(Schema.Boolean),
  // Show every project's worktrees under it on the sidebar's list of
  // projects, each project folding in place, rather than one project
  // at a time. Off by default (absent = off), explicit `true` is the
  // opt-in.
  inlineWorktrees: Schema.optional(Schema.Boolean),
  // Pause the doubutsu wallpaper drift while this machine runs on
  // battery, the same pause an unfocused window gets. On by default
  // (absent = on), explicit `false` keeps it drifting on battery.
  pauseAnimationsOnBattery: Schema.optional(Schema.Boolean),
  // "Keep this device reachable": the single opt-in behind two liveness
  // capabilities the main process reconciles (main/electron/liveness.ts).
  // When on, the app registers a login item so it starts when the user
  // logs in, and it best-effort relaunches itself after a recoverable
  // crash so a machine the user hosts stays online for the device
  // hub. Per-machine and never synced, like the rest of client config:
  // the CLI never reads it and it does not ride any sync path. Default is
  // on (absent = on): a machine on the account is meant to be there for
  // the others, and explicit `false` is the opt-out.
  keepReachable: Schema.optional(Schema.Boolean),
  // Where a peer's port lands on this machine when forwarded: local port
  // by `${deviceId}:${remotePort}` (renderer/hooks/config/
  // useForwardLocalPort.ts is the only reader and writer). Keyed by
  // device and remote port rather than by worktree because that is the
  // engine's own identity for a forward (host/portForward/engine.ts
  // dedupes on the same pair). Only preferences that differ from the
  // default (the remote port itself) are stored, so the map stays as
  // small as the user's overrides.
  forwardLocalPorts: Schema.optional(
    Schema.Record(Schema.String, PortNumberSchema),
  ),
  // Legacy: the create-device picks, from before they became a shared
  // setting (sharedSettings.ts, quickCreateDevice). Nothing
  // reads it but the one-time move in
  // renderer/lib/remote/sharedSettingsSync.ts, which clears it. Still
  // modeled so a doc that carries it parses and the move can see it.
  quickCreateDevices: Schema.optional(
    Schema.Record(Schema.String, Schema.String),
  ),
  // Which sidebar layout this window shows: the classic tree, or the
  // flat cross-project inbox. A preference of the window rather than
  // of a host, so a hostless client keeps one too. Absent means the
  // tree.
  sidebarView: Schema.optional(SidebarViewSchema),
  // How the sidebar orders its projects. A preference of the window,
  // like the view above: the CLI never reads it, and a peer has no say
  // in how this machine lists them. Absent means the manual order
  // (renderer/hooks/projects/useProjectSort.ts is the only reader and
  // writer, and stores the default as nothing).
  projectsSort: Schema.optional(ProjectSortModeSchema),
  // Whether the sidebar's list of projects is split under a header per
  // owner (the org or user of each project's remote, Project.remote).
  // Kept like the sort above. On by default (absent = on), explicit
  // `false` is the opt-out (renderer/hooks/projects/useProjectSort.ts).
  groupProjectsByOwner: Schema.optional(Schema.Boolean),
  // The projects folded on the inline list, by group key
  // (projectGroupKey in the ui package's views/sidebar/buildSidebarRows.ts).
  // Absence == expanded (renderer/hooks/projects/useCollapsedProjects.ts
  // is the only reader and writer).
  collapsedProjects: Schema.optional(Schema.Array(Schema.String)),
});
export type ClientConfig = typeof ClientConfigSchema.Type;

// The group key of a peer's project with no repo identity: it can only
// group with itself, so it is named by its device and its id. The
// prefix sets it apart from a repo identity (`root:` or `remote:`,
// the engine's Identity.ts) and from a local project id (a folder
// name, never holding a `/`).
export const peerProjectKey = (deviceId: string, projectId: string) =>
  `device:${deviceId}/${projectId}`;

// The client config without what was keyed by the account's peers:
// a device leaving the account (a sign-out, a sign-in under another)
// leaves the local port picks, the legacy create-device picks and the
// folded projects behind, since all three name devices or repos of
// the account that is gone, and a later account on this machine or
// browser must not inherit them.
export function withoutPeerState(config: ClientConfig): ClientConfig {
  const {
    forwardLocalPorts: _forwardLocalPorts,
    quickCreateDevices: _quickCreateDevices,
    collapsedProjects: _collapsedProjects,
    ...rest
  } = config;
  return rest;
}

// The one reading of keepReachable: on unless switched off. Every
// reader (the liveness reconcile, the write handler's change gate, the
// toggle) asks here, so the default lives in one place.
export function keepReachableOn(
  config: Pick<ClientConfig, "keepReachable">,
): boolean {
  return config.keepReachable !== false;
}

// Read-side counterpart, loose like StoredGlobalConfigSchema.
export const StoredClientConfigSchema = loose(ClientConfigSchema);

export const WriteClientConfigPayloadSchema = Schema.Struct({
  config: ClientConfigSchema,
});

export const WriteShigomoriPayloadSchema = Schema.Struct({
  ...ProjectScopedPayloadSchema.fields,
  config: ShigomoriConfigSchema,
});

// Per-worktree data payloads key the engine's rows by `worktreeId`
// directly (unlike other handlers, which route the id through git's
// worktree list first), so it is held to the exact 12-hex shape that
// `worktreeIdFromPath` produces. The derived worktree id
// (worktreeIdFromPath in the engine's worktreeLayout.ts): the first 12 hex
// chars of the path's sha256. One schema for every payload that names one.
export const WorktreeIdSchema = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{12}$/),
);

export const ReadWorktreeDataPayloadSchema = Schema.Struct({
  ...ProjectScopedPayloadSchema.fields,
  worktreeId: WorktreeIdSchema,
});

// The renderer's write: the custom ports, the one part of the
// worktree's data it owns (the title and description have writers of
// their own).
export const WriteWorktreeDataPayloadSchema = Schema.Struct({
  ...ReadWorktreeDataPayloadSchema.fields,
  data: Schema.Struct({ ports: ShigomoriWorktreeDataSchema.fields.ports }),
});

export const WriteWorktreeDescriptionPayloadSchema = Schema.Struct({
  ...ReadWorktreeDataPayloadSchema.fields,
  description: WorktreeDescriptionSchema,
});

// Input to the window module's non-persisting theme preview.
export const PreviewThemePayloadSchema = Schema.Struct({
  theme: ThemeSchema,
});

export const NotifyPayloadSchema = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  route: Schema.String,
});
