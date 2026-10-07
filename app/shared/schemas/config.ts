import { z } from "zod";
import { isSafeRelPath } from "../git/gitPaths";
import { ProjectScopedPayloadSchema } from "./zodPayloads";
import { MergeMethodSchema } from "./pullRequest";
import { CustomPortSchema, MAX_CUSTOM_PORTS, PortNumberSchema } from "./ports";
import { ProjectSortModeSchema, SidebarViewSchema } from "./project";

const ThemeSchema = z.enum(["light", "dark", "system"]);
export type Theme = z.infer<typeof ThemeSchema>;

// The doubutsu palettes, one list per appearance. renderer/doubutsu.css
// carries the defaults (cream, charcoal), renderer/palettes.css the
// rest. The catalog in shared/themes.ts names them and pairs each light
// over its dark twin.
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
const LightThemeSchema = z.enum(LIGHT_THEME_IDS);
const DarkThemeSchema = z.enum(DARK_THEME_IDS);
export type LightTheme = z.infer<typeof LightThemeSchema>;
export type DarkTheme = z.infer<typeof DarkThemeSchema>;

const LauncherCommandSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  command: z.string().min(1),
});
export type LauncherCommand = z.infer<typeof LauncherCommandSchema>;

// Files/folders to carry over from the primary checkout into newly-created
// worktrees. `path` is relative to the project root; gitignored entries are
// the expected source. `symlink` keeps state shared; `copy` snapshots.
const CarryOverEntrySchema = z.object({
  path: z.string().min(1).refine(isSafeRelPath, {
    message: "Path must stay within the project root",
  }),
  mode: z.enum(["copy", "symlink"]),
});
export type CarryOverEntry = z.infer<typeof CarryOverEntrySchema>;

// Where shigomori's managed worktrees for this project live on disk.
// - managed-root: <dataDir>/worktrees/<projectName>/<worktreeName>
//   (default; one place for every project's worktrees, easy to nuke.
//   The device's managedOnProjectDrive setting moves it onto the
//   drive of a project that sits on an external one)
// - in-project: <projectPath>/.shigomori/worktrees/<worktreeName>
//   (sits inside the primary; lets tools that walk up to a workspace
//   root, like Turbopack, accept symlinked node_modules from carry-over)
// - custom: <customWorktreePath>/<worktreeName>
//   (escape hatch, not recommended, since it can collide with other
//   repos and complicates external-vs-managed detection)
const WorktreeLayoutSchema = z.enum(["managed-root", "in-project", "custom"]);
export type WorktreeLayout = z.infer<typeof WorktreeLayoutSchema>;

// Per-project config. Stored at <dataDir>/projects/<projectId>.json
// and managed by the app, not committed to the user's repo.
// Strict on purpose. It doubles as the shigomori:write IPC input, so a
// key the renderer invents is dropped at the boundary instead of being
// persisted into the user's file. Reads use the Stored variant below.
export const ShigomoriConfigSchema = z.object({
  scripts: z
    .object({
      setup: z.string().optional(),
      teardown: z.string().optional(),
    })
    .partial()
    .optional(),
  launchers: z.array(LauncherCommandSchema).optional(),
  portBase: z.number().int().positive().optional(),
  defaultBranch: z.string().min(1),
  carryOver: z.array(CarryOverEntrySchema).optional(),
  // When false, the repo's .worktreeinclude file is ignored at worktree
  // creation. Absent = enabled (the integration is opt-out).
  useWorktreeInclude: z.boolean().optional(),
  worktreeLayout: WorktreeLayoutSchema.optional(),
  // Absolute path; only meaningful when worktreeLayout === "custom".
  customWorktreePath: z.string().optional(),
  // Last merge method picked for this project's PRs. Drives the split-
  // button's primary action so each repo remembers its house style.
  // Falls back to whatever the repo allows when the saved value is
  // disabled at GitHub.
  lastMergeMethod: MergeMethodSchema.optional(),
  // When true, the inbox view lists this project's primary checkout
  // alongside its worktrees (always live, never shelved or merged).
  // Per project because the primary means different things in
  // different repos: in some it's a place you work, in most it's just
  // the root. Off by default. Absent = hidden.
  showPrimaryInInbox: z.boolean().optional(),
});
export type ShigomoriConfig = z.infer<typeof ShigomoriConfigSchema>;

// In a module of its own, which the layout math can import without zod.
export { PROJECT_CONFIG_DEFAULTS } from "./projectConfigDefaults";

// The object shape a schema field holds under its wrappers (optional,
// nullable, default and the like), or null for a field that isn't an
// object.
function objectShapeOf(field: z.ZodType): Record<string, z.ZodType> | null {
  let inner = field;
  while ("innerType" in inner.def) inner = inner.def.innerType as z.ZodType;
  return inner instanceof z.ZodObject ? inner.shape : null;
}

// Every field a schema models, as the keys down to it, nested objects
// field by field (["scripts", "setup"]). The host's project write and
// the cli-reads key check both walk it.
export function modeledKeyPaths(
  shape: Record<string, z.ZodType>,
  prefix: string[] = [],
): string[][] {
  return Object.entries(shape).flatMap(([name, field]) => {
    const path = prefix.concat(name);
    const nested = objectShapeOf(field);
    return nested ? modeledKeyPaths(nested, path) : [path];
  });
}

// The same document as read from disk, where a newer version may have
// left keys this build doesn't model. Loose so the app doesn't strip
// them out from under the user. They never have to ride back out in a
// write payload: the CLI's `config write` merges into the file rather
// than replacing it, so a key the payload doesn't mention stays put.
export const StoredShigomoriConfigSchema = ShigomoriConfigSchema.loose();

// Snapshot of the repo's .worktreeinclude file (Claude Code convention:
// gitignore-syntax patterns whose gitignored matches are copied into new
// worktrees). Read-only from the app's side; the file belongs to the repo.
export const WorktreeIncludeStatusSchema = z.object({
  fileExists: z.boolean(),
  // Paths the file's patterns currently resolve to (matched AND
  // gitignored), in git's raw shape: fully-ignored directories keep
  // their trailing slash. Matches what creation-time reconciliation
  // sees, so the UI's covered badge and the actual auto-removal agree.
  // Empty when resolution fails.
  matchedPaths: z.array(z.string()),
});
export type WorktreeIncludeStatus = z.infer<typeof WorktreeIncludeStatusSchema>;

// The carry-over picker reads a union of the primary and every
// worktree: entries are root-relative, so any checkout can hold them
// and the CLI copies from whichever has the file at creation.
export const CarryOverListingPayloadSchema = ProjectScopedPayloadSchema.extend({
  // Folder being browsed, root-relative, with "" for the root.
  relative: z.union([z.literal(""), CarryOverEntrySchema.shape.path]),
  // Also call a folder ignored when a rule names it though it holds a
  // force-added file (what a mirror leaves out, where carry-over needs
  // git's own verdict). A peer from before the flag drops it and
  // answers without.
  ruleIgnored: z.boolean().optional(),
});

// One name in the browsed folder, across checkouts. `ignored` is judged
// by the gitignore of a checkout that has it. `worktrees` names the
// non-primary checkouts holding it.
export const CarryOverCandidateSchema = z.object({
  name: z.string(),
  isDirectory: z.boolean(),
  ignored: z.boolean(),
  inPrimary: z.boolean(),
  worktrees: z.array(z.string()),
});
export type CarryOverCandidate = z.infer<typeof CarryOverCandidateSchema>;

export const CarryOverStatsPayloadSchema = ProjectScopedPayloadSchema.extend({
  paths: z.array(CarryOverEntrySchema.shape.path),
});

// Where a configured entry currently exists. Missing everywhere when
// neither `inPrimary` nor any `worktrees`.
export const CarryOverStatSchema = z.object({
  isDirectory: z.boolean(),
  inPrimary: z.boolean(),
  worktrees: z.array(z.string()),
});
export type CarryOverStat = z.infer<typeof CarryOverStatSchema>;

// A worktree's title and description: what its work is, set by `sm
// describe` (cli/cmd_describe.go) until a pull request's title and
// body take over. describedAt (epoch ms) is when they were last set,
// so a mirror's two sides keep the newer pair. Only `sm describe` and
// the moves between devices write them (writeWorktreeDescription).
const WorktreeDescriptionSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  describedAt: z.number().int().nonnegative().optional(),
});
export type WorktreeDescription = z.infer<typeof WorktreeDescriptionSchema>;

// Per-worktree persistent data. Only kept for shigomori-managed worktrees;
// external worktrees deliberately have no on-disk state.
export const ShigomoriWorktreeDataSchema = WorktreeDescriptionSchema.extend({
  // Ports the user added beside port-pool's (see shared/schemas/ports.ts).
  // The renderer's one key here, written through useWorktreeDataWrite;
  // the host merges it into the stored document under its lock.
  ports: z.array(CustomPortSchema).max(MAX_CUSTOM_PORTS).optional(),
});
export type ShigomoriWorktreeData = z.infer<typeof ShigomoriWorktreeDataSchema>;

// Global, per-device config kept in <dataDir>/config.json. Holds
// preferences that span every project: custom launchers the user wants
// everywhere (claude, tmux, an editor command, etc.), and room for future
// settings.
// Device config only: every key here gates what this machine can do,
// so both the host and the CLI read it. How the app instance looks
// (theme, palettes) is client config and lives in ClientConfigSchema
// below.
// Reads use the loose Stored variant below: pre-split installs can
// still carry legacy client keys (and keys from newer builds) in
// config.json, and those have to pass through unrejected.
const GlobalConfigSchema = z.object({
  launchers: z.array(LauncherCommandSchema).optional(),
  // Launcher entry ids (`app:cursor`, `web:github`, `custom:<uuid>`) the
  // user has switched off, so they're skipped when building a project's
  // launcher row, and therefore also absent from the File menu's
  // ⌘1..⌘9, which mirrors the row. Everything is shown by default;
  // absent = nothing hidden. Ids that no longer resolve (an app the user
  // uninstalled, a deleted custom tool) simply never match and are
  // harmless to keep.
  hiddenLaunchers: z.array(z.string()).optional(),
  // When true, the Launch section carries a second row of the worktree's
  // top package.json scripts, as many as fit on one line, ordered by the
  // project's script sort. On by default; absent = on, explicit `false` is
  // the opt-out.
  launchScripts: z.boolean().optional(),
  // When false, deleting a worktree keeps its checked-out local branch
  // (deletion is skipped anyway if the branch is the primary's or in
  // use by another worktree). ON by default. Unset means delete
  // (cli/cmd_rm.go, which every removal runs through).
  deleteBranchOnRemove: z.boolean().optional(),
  // When true, adding a project with a package.json seeds its setup
  // script with `<detected-pm> install`. Only fires at project-add
  // time; existing projects are untouched.
  autoPopulateInstall: z.boolean().optional(),
  // When true, a new worktree, and the primary checkout of a newly
  // added project, start out with auto-pull on (the mark `sm worktrees
  // autopull` sets). Only fires at create and add time, in the CLI
  // (cli/state.go markAutoPullIfNew). Existing
  // worktrees keep their footer toggle as they are.
  autoPullNew: z.boolean().optional(),
  // When true, autoPullNew covers only the primary checkout of a newly
  // added project. Nothing on its own.
  autoPullPrimaryOnly: z.boolean().optional(),
  // When true, auto-picked worktree names are Animal Crossing villager
  // and character names, the ones with a face on Nookipedia
  // (cli/embed/doubutsu-names.json, e.g. `raymond`), instead of
  // adjective + animal pairs (`snug-otter`). Picked by the CLI
  // (cli/names.go), at create time and for the New Worktree form's
  // pre-pick (`sm worktrees destination`). Absent reads as off, so an
  // install from before it defaulted on keeps its names. A fresh
  // install is seeded with `true` instead (host/lib/bootstrap.ts,
  // cli/state.go seedFreshInstall).
  doubutsuNames: z.boolean().optional(),
  // When true, an external worktree whose folder is just the repo's
  // name (Codex and other tools lay worktrees out as
  // <worktree-name>/<repo-name>) is named after the folder above it.
  // Off by default: a worktree that merely shares the repo's folder
  // name would take whatever folder it sits in. Applied wherever the
  // CLI lists worktrees (cli/gitx.go), the app's rows included.
  codexWorktreeNames: z.boolean().optional(),
  // When true, a project on an external drive keeps its managed-layout
  // worktrees on that drive
  // (<volume>/<dataDirName>/worktrees/<projectName>/<worktreeName>)
  // instead of under the data dir. Nothing changes for a project on the
  // internal drive, one whose drive already holds the data dir, or one
  // on another layout. Decided by the CLI wherever it places a worktree
  // (cli/paths.go resolveWorktreeBase). Worktrees made before the
  // switch stay where they are until the project's Worktree location
  // page moves them. Off by default.
  managedOnProjectDrive: z.boolean().optional(),
  // When true, projects with a valid port-pool.config.json run
  // `port-pool provision` after setup at create and
  // `port-pool release` before teardown at delete.
  portPool: z.boolean().optional(),
  // When true, repos registered in terrier (github.com/dittofleet/terrier)
  // are listed as projects alongside the registry's own. Terrier-sourced
  // projects can't be removed here, only `terrier rm` unregisters them. A
  // path registered in both is an ordinary removable project, and
  // removing its registry entry demotes it back to terrier-sourced. Off by
  // default, and only active while `terrier` is on PATH at a version
  // this build understands (cli/terrier.go).
  terrier: z.boolean().optional(),
  // When true, GitHub CLI features light up wherever they apply.
  // Activates only when `gh` is on PATH and authenticated. On by
  // default; matches the integration being opt-out rather than opt-in.
  githubCli: z.boolean().optional(),
  // Direct data plane: when false, this device neither runs the direct
  // listener nor is advertised to peers, so it serves no peers at all
  // (its own dials to peers are unaffected). ON by default (absent =
  // enrolled, explicit `false` is the opt-out). Config-only (no
  // Settings UI): toggle by editing config.json or `sm config edit`.
  directConnections: z.boolean().optional(),
  // Tunnel endpoints: absolute path to the
  // cloudflared binary, for installs not on PATH. Absent means PATH
  // discovery. A missing binary reads as tunnels off with a typed
  // status, never an error loop. Config-only, like directConnections.
  cloudflaredPath: z.string().optional(),
});
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

// Read-side counterpart, loose like StoredShigomoriConfigSchema. Also
// the globalConfig:read output, so legacy and newer keys pass through.
export const StoredGlobalConfigSchema = GlobalConfigSchema.loose();

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
export const DeviceSettingsPatchSchema = z.strictObject(
  GlobalConfigSchema.pick({
    launchers: true,
    hiddenLaunchers: true,
    launchScripts: true,
    deleteBranchOnRemove: true,
    autoPopulateInstall: true,
    autoPullNew: true,
    autoPullPrimaryOnly: true,
    doubutsuNames: true,
    codexWorktreeNames: true,
    managedOnProjectDrive: true,
    portPool: true,
    terrier: true,
    githubCli: true,
  }).shape,
);
export type DeviceSettingsPatch = z.infer<typeof DeviceSettingsPatchSchema>;

export const WriteDeviceSettingsPayloadSchema = z.object({
  patch: DeviceSettingsPatchSchema,
});

// The value each device setting takes while its key is absent from
// config.json. One table for both ends of the settings write: the form
// decodes a missing key with it (fromConfig in
// renderer/hooks/config/useSettingsSave.ts), and the host's patch
// handler stores a key equal to its default by deleting it, so the file
// stays tidy whichever device saved it. The CLI's key registry
// (cli/cmd_config.go globalConfigKeys) mirrors these keys and
// defaults, and the cli-reads proof holds the two together.
export const DEVICE_SETTINGS_DEFAULTS: Required<DeviceSettingsPatch> = {
  launchers: [],
  hiddenLaunchers: [],
  launchScripts: true,
  deleteBranchOnRemove: true,
  autoPopulateInstall: false,
  autoPullNew: false,
  autoPullPrimaryOnly: false,
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
// Doubles as the clientConfig:write IPC input. z.object STRIPS unknown
// keys rather than rejecting them, which drops a key the renderer
// invents at the boundary, and it must not become .strict(): a key
// from a newer build has to keep passing through unrejected.
export const ClientConfigSchema = z.object({
  theme: ThemeSchema.optional(),
  // "Animal Crossing" visual mode. Orthogonal to theme: when on, both
  // the light and dark palettes shift to a bolder, color-blocked,
  // Zen-Maru-Gothic-typeset look. On by default (absent = on), explicit
  // `false` is the opt-out back to the v1 look. Mirrored to
  // localStorage so startup paints without a flash.
  doubutsu: z.boolean().optional(),
  // Which doubutsu palette each appearance wears (shared/themes.ts),
  // picked separately for light and dark the way most apps offer it.
  // Absent is the default of each list, cream and charcoal. Kept while
  // doubutsu is off, so switching it back on restores the picks.
  // Mirrored to localStorage with the switch.
  lightTheme: LightThemeSchema.optional(),
  darkTheme: DarkThemeSchema.optional(),
  // Village life: the purely visual villager extras on worktrees named
  // after a character, on every device this window shows. Needs the
  // villager data, downloaded into this device's data dir
  // (host/lib/villagers.ts), so only the desktop offers it: a web
  // client has no device of its own. Off by default (absent = off),
  // explicit `true` is the opt-in. Nothing on a device reads it.
  villageLife: z.boolean().optional(),
  // Mark the sidebar's terrier-sourced projects (Project.source), the
  // ones the terrier registry lists rather than this app's own, with
  // terrier's paw, on every device this window shows. Off by default
  // (absent = off), explicit `true` is the opt-in.
  markTerrierProjects: z.boolean().optional(),
  // The device badges on the sidebar's rows: the mark of each device a
  // project spans on its header, and of the device a worktree lives on
  // (or is mirrored with) on its row. On by default (absent = on),
  // explicit `false` hides them, on every device this window shows.
  showDeviceBadges: z.boolean().optional(),
  // Pause the doubutsu wallpaper drift while this machine runs on
  // battery, the same pause an unfocused window gets. On by default
  // (absent = on), explicit `false` keeps it drifting on battery.
  pauseAnimationsOnBattery: z.boolean().optional(),
  // "Keep this device reachable": the single opt-in behind two liveness
  // capabilities the main process reconciles (main/electron/liveness.ts).
  // When on, the app registers a login item so it starts when the user
  // logs in, and it best-effort relaunches itself after a recoverable
  // crash so a machine the user hosts stays online for the device
  // hub. Per-machine and never synced, like the rest of client config:
  // the CLI never reads it and it does not ride any sync path. Default is
  // on (absent = on): a machine on the account is meant to be there for
  // the others, and explicit `false` is the opt-out.
  keepReachable: z.boolean().optional(),
  // Where a peer's port lands on this machine when forwarded: local port
  // by `${deviceId}:${remotePort}` (renderer/hooks/config/
  // useForwardLocalPort.ts is the only reader and writer). Keyed by
  // device and remote port rather than by worktree because that is the
  // engine's own identity for a forward (main/core/portForward/engine.ts
  // dedupes on the same pair). Only preferences that differ from the
  // default (the remote port itself) are stored, so the map stays as
  // small as the user's overrides.
  forwardLocalPorts: z.record(z.string(), PortNumberSchema).optional(),
  // Legacy: the create-device picks, from before they became a shared
  // setting (shared/sharedSettings.ts, quickCreateDevice). Nothing
  // reads it but the one-time move in
  // renderer/lib/remote/sharedSettingsSync.ts, which clears it. Still
  // modeled so a doc that carries it parses and the move can see it.
  quickCreateDevices: z.record(z.string(), z.string()).optional(),
  // Which sidebar layout this window shows: the classic tree, or the
  // flat cross-project inbox. A preference of the window rather than
  // of a host, so a hostless client keeps one too. Absent means the
  // tree.
  sidebarView: SidebarViewSchema.optional(),
  // How the sidebar orders its projects. A preference of the window,
  // like the view above: the CLI never reads it, and a peer has no say
  // in how this machine lists them. Absent means the manual order
  // (renderer/hooks/projects/useProjectSort.ts is the only reader and
  // writer, and stores the default as nothing).
  projectsSort: ProjectSortModeSchema.optional(),
  // Whether the sidebar's list of projects is split under a header per
  // owner (the org or user of each project's remote, Project.remote).
  // Kept like the sort above. On by default (absent = on), explicit
  // `false` is the opt-out (renderer/hooks/projects/useProjectSort.ts).
  groupProjectsByOwner: z.boolean().optional(),
  // Legacy: the sidebar's folded projects, by group key, from when its
  // tree folded project by project. Nothing reads it. Still modeled
  // because a doc can carry it and its keys name peers and repos, so
  // withoutPeerState has to be able to see it to drop it.
  collapsedProjects: z.array(z.string()).optional(),
});
export type ClientConfig = z.infer<typeof ClientConfigSchema>;

// The group key of a peer's project with no repo identity: it can only
// group with itself, so it is named by its device and its id. The
// prefix sets it apart from a repo identity (`root:` or `remote:`,
// shared/git/repoIdentity.mts) and from a local project id (a folder
// name, never holding a `/`).
export const peerProjectKey = (deviceId: string, projectId: string) =>
  `device:${deviceId}/${projectId}`;

// The client config without what was keyed by the account's peers:
// a device leaving the account (a sign-out, a sign-in under another)
// leaves the local port picks, the legacy create-device picks and the
// legacy fold list behind, since all three name devices or repos of
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
export const StoredClientConfigSchema = ClientConfigSchema.loose();

export const WriteClientConfigPayloadSchema = z.object({
  config: ClientConfigSchema,
});

export const WriteShigomoriPayloadSchema = ProjectScopedPayloadSchema.extend({
  config: ShigomoriConfigSchema,
});

// Per-worktree data IPC payloads construct filesystem paths directly from
// `worktreeId` (unlike other handlers, which route the id through git's
// worktree list first). Constrain it to the exact 12-hex shape that
// `worktreeIdFromPath` produces so a malformed id can't escape the
// projects/<id>/worktrees/ directory.
// The derived worktree id (worktreeIDFromPath in cli/paths.go): the
// first 12 hex chars of the path's sha256. One schema for every
// payload that names one.
export const WorktreeIdSchema = z.string().regex(/^[0-9a-f]{12}$/);

export const ReadWorktreeDataPayloadSchema = ProjectScopedPayloadSchema.extend({
  worktreeId: WorktreeIdSchema,
});

// The renderer's write: the custom ports, the one part of the file it
// owns (the title and description have writers of their own).
export const WriteWorktreeDataPayloadSchema =
  ReadWorktreeDataPayloadSchema.extend({
    data: ShigomoriWorktreeDataSchema.pick({ ports: true }),
  });

export const WriteWorktreeDescriptionPayloadSchema =
  ReadWorktreeDataPayloadSchema.extend({
    description: WorktreeDescriptionSchema,
  });

// Input to the window module's non-persisting theme preview.
export const PreviewThemePayloadSchema = z.object({
  theme: ThemeSchema,
});
