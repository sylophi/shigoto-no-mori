import { Schema, Struct } from "effect";
import { isSafeRelPath } from "../git/gitPaths";
import { ProjectScopedPayloadSchema } from "./payloads";
import { MergeMethodSchema } from "./pullRequest";
import { CustomPortSchema, MAX_CUSTOM_PORTS, PortNumberSchema } from "./ports";
import { SidebarViewSchema } from "./project";
import { strictStruct } from "./strict";

const ThemeSchema = Schema.Literals(["light", "dark", "system"]);
export type Theme = typeof ThemeSchema.Type;

// A document read from disk keeps the keys this build does not model
// (zod's .loose()): the struct's own keys decode as declared, and every
// other own key rides through as it was.
const loose = <S extends Schema.Struct<Schema.Struct.Fields>>(struct: S) =>
  Schema.StructWithRest(struct, [Schema.Record(Schema.String, Schema.Unknown)]);

export const LauncherCommandSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  label: Schema.NonEmptyString,
  command: Schema.NonEmptyString,
});
export type LauncherCommand = typeof LauncherCommandSchema.Type;

// Files/folders to carry over from the primary checkout into newly-created
// worktrees. `path` is relative to the project root; gitignored entries are
// the expected source. `symlink` keeps state shared; `copy` snapshots.
const CarryOverPathSchema = Schema.NonEmptyString.check(
  Schema.makeFilter(isSafeRelPath, {
    message: "Path must stay within the project root",
  }),
);

export const CarryOverEntrySchema = Schema.Struct({
  path: CarryOverPathSchema,
  mode: Schema.Literals(["copy", "symlink"]),
});
export type CarryOverEntry = typeof CarryOverEntrySchema.Type;

// Where shigomori's managed worktrees for this project live on disk.
// - managed-root: <dataDir>/worktrees/<projectName>/<worktreeName>
//   (default; one place for every project's worktrees, easy to nuke)
// - in-project: <projectPath>/.shigomori/worktrees/<worktreeName>
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

// Per-project config. Stored at <dataDir>/projects/<projectId>.json
// and managed by the app, not committed to the user's repo.
// Strict on purpose. It doubles as the shigomori:write IPC input, so a
// key the renderer invents is dropped at the boundary instead of being
// persisted into the user's file. Reads use the Stored variant below.
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

// The same document as read from disk, where a newer version may have
// left keys this build doesn't model. Loose so the app doesn't strip
// them out from under the user. They never have to ride back out in a
// write payload: the CLI's `config write` merges into the file rather
// than replacing it, so a key the payload doesn't mention stays put.
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
// and the CLI copies from whichever has the file at creation.
export const CarryOverListingPayloadSchema = Schema.Struct({
  ...ProjectScopedPayloadSchema.fields,
  // Folder being browsed, root-relative, with "" for the root.
  relative: Schema.Union([Schema.Literal(""), CarryOverPathSchema]),
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

// Per-worktree persistent data. Only kept for shigomori-managed worktrees;
// external worktrees deliberately have no on-disk state.
export const ShigomoriWorktreeDataSchema = Schema.Struct({
  notes: Schema.optional(Schema.String),
  // Ports the user added beside port-pool's (see shared/schemas/ports.ts).
  // The write is a full replace, so every renderer writer goes through
  // useWorktreeDataWrite, which merges a patch over the stored document.
  ports: Schema.optional(
    Schema.Array(CustomPortSchema).check(Schema.isMaxLength(MAX_CUSTOM_PORTS)),
  ),
});
export type ShigomoriWorktreeData = typeof ShigomoriWorktreeDataSchema.Type;

// Global, per-device config kept in <dataDir>/config.json. Holds
// preferences that span every project: custom launchers the user wants
// everywhere (claude, tmux, an editor command, etc.), and room for future
// settings.
// Device config only: every key here gates what this machine can do,
// so both the host and the CLI read it. How the app instance looks
// (theme, doubutsu) is client config and lives in ClientConfigSchema
// below.
// Doubles as the globalConfig:write IPC input. Schema.Struct STRIPS
// unknown keys rather than rejecting them, and it must not become
// strict (strictStruct):
// pre-split installs can still carry legacy client keys (and keys from
// newer builds) in config.json, and those have to keep passing through
// the write path unrejected. The stripping is also what drops a key
// the renderer invents at the boundary instead of persisting it.
export const GlobalConfigSchema = Schema.Struct({
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
  // When false, deleting a worktree keeps its checked-out local branch
  // (deletion is skipped anyway if the branch is the primary's or in
  // use by another worktree). ON by default. Unset means delete, in
  // both engines (cli/cmd_config.go and host/lib/nuke.ts).
  deleteBranchOnRemove: Schema.optional(Schema.Boolean),
  // When true, adding a project with a package.json seeds its setup
  // script with `<detected-pm> install`. Only fires at project-add
  // time; existing projects are untouched.
  autoPopulateInstall: Schema.optional(Schema.Boolean),
  // When true, a new worktree, and the primary checkout of a newly
  // added project, start out with auto-pull on
  // (host/lib/worktrees/autoPull.ts). Only fires at create and add
  // time, in the CLI (cli/state.go markAutoPullIfNew). Existing
  // worktrees keep their footer toggle as they are.
  autoPullNew: Schema.optional(Schema.Boolean),
  // When true, autoPullNew covers only the primary checkout of a newly
  // added project. Nothing on its own.
  autoPullPrimaryOnly: Schema.optional(Schema.Boolean),
  // When true, projects with a valid port-pool.config.json run
  // `port-pool provision` after setup at create and
  // `port-pool release` before teardown at delete.
  portPool: Schema.optional(Schema.Boolean),
  // When true, repos registered in terrier (github.com/sylophi/terrier)
  // are listed as projects alongside the registry's own. Terrier-sourced
  // projects can't be removed here, only `terrier rm` unregisters them. A
  // path registered in both is an ordinary removable project, and
  // removing its registry entry demotes it back to terrier-sourced. Off by
  // default, and only active while `terrier` is on PATH at a version
  // this build understands (host/lib/terrier.ts, cli/terrier.go).
  terrier: Schema.optional(Schema.Boolean),
  // When true, GitHub CLI features light up wherever they apply.
  // Activates only when `gh` is on PATH and authenticated. On by
  // default; matches the integration being opt-out rather than opt-in.
  githubCli: Schema.optional(Schema.Boolean),
  // Remote hosting: when enabled with a nonempty
  // token, the app serves the REMOTE-tagged host IPC to clients over a
  // websocket (host/socket/server.ts). Off by default, and gated on the
  // token so a bare `enabled: true` can never open an unauthenticated
  // listener. Secure by default: enabling binds LOOPBACK only. Exposing
  // the port to the network is a separate explicit opt-in (`lan`). The
  // token is high-entropy generated at enable time, never echoed back
  // over a read (the read contract redacts it, see RedactedSocketHost
  // below). Step 4 replaces this shared-token auth wholesale with
  // pairing, so nothing else should grow to depend on the token's
  // shape. Direct data plane: when false, this
  // device neither runs the direct listener nor is advertised to peers,
  // so all its remote traffic stays on the device hub. ON by default
  // (absent = enrolled, explicit `false` is the opt-out), matching the
  // feature being an internal transport optimization rather than a
  // capability. Config-only for now (no Settings UI, like socketHost
  // below): toggle by editing config.json or `sm config edit`.
  directConnections: Schema.optional(Schema.Boolean),
  // Tunnel endpoints: absolute path to the
  // cloudflared binary, for installs not on PATH. Absent means PATH
  // discovery. A missing binary reads as tunnels off with a typed
  // status, never an error loop. Config-only, like directConnections.
  cloudflaredPath: Schema.optional(Schema.String),
  socketHost: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean),
      // Absent = DEFAULT_SOCKET_PORT (shared/ipc/socket/frames.ts).
      port: Schema.optional(PortNumberSchema),
      // When true, bind 0.0.0.0 so other machines on the LAN can reach
      // the listener. Absent or false binds 127.0.0.1: enabling hosting
      // alone never exposes the port to the network.
      lan: Schema.optional(Schema.Boolean),
      token: Schema.optional(Schema.String),
    }),
  ),
});
export type GlobalConfig = typeof GlobalConfigSchema.Type;

// Read-side counterpart, loose like StoredShigomoriConfigSchema.
export const StoredGlobalConfigSchema = loose(GlobalConfigSchema);

// The socketHost shape a globalConfig READ is allowed to return. The
// token is a secret and must be structurally absent from any wire, so
// this schema has no token field at all. A derived `tokenSet` boolean
// lets a future Settings UI show that hosting is configured without
// ever carrying the value. The redaction itself happens in the read
// handler (host/lib/config/global.ts), since packaged builds skip
// output re-parsing, so this schema documents and validates the shape
// rather than being the thing that strips the secret.
const RedactedSocketHostSchema = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  port: Schema.optional(PortNumberSchema),
  lan: Schema.optional(Schema.Boolean),
  tokenSet: Schema.optional(Schema.Boolean),
});

// Output schema for globalConfig:read. Loose like the stored variant so
// legacy and newer keys pass through, but with socketHost forced to the
// redacted shape so a token can never ride out on a read. The read
// handler also drops the legacy `remoteDevices` key wholesale
// (host/lib/config/global.ts): the removed LAN feature stored per-host
// tokens under it, and an old config may still carry them.
export const ReadGlobalConfigSchema = loose(
  Schema.Struct({
    ...GlobalConfigSchema.fields,
    socketHost: Schema.optional(RedactedSocketHostSchema),
  }),
);
export type ReadGlobalConfig = typeof ReadGlobalConfigSchema.Type;

export const WriteGlobalConfigPayloadSchema = Schema.Struct({
  config: GlobalConfigSchema,
});

// The device-scoped settings subset a REMOTE peer may write: exactly
// the keys the Settings form manages (managedDeviceConfig in
// renderer/hooks/config/useSettingsSave.ts). STRICT on purpose, unlike
// GlobalConfigSchema: an unknown key REJECTS rather than strips, so the
// schema itself proves that `socketHost` (the hosting token), like any
// other unmanaged or legacy key, can never ride a remote write. Patch
// semantics: every key optional, only provided
// keys change, and the host handler spreads them over the local unredacted
// document so everything the patch does not name rides through intact.
// Derived by picking from GlobalConfigSchema rather than respelling the
// field types, so a managed key's shape cannot drift between the local
// write and the remote patch. A NEW managed device setting still has to
// be named here, or the strict reject makes it un-writable remotely.
export const DeviceSettingsPatchSchema = strictStruct(
  Struct.pick(GlobalConfigSchema.fields, [
    "launchers",
    "hiddenLaunchers",
    "launchScripts",
    "deleteBranchOnRemove",
    "autoPopulateInstall",
    "autoPullNew",
    "autoPullPrimaryOnly",
    "portPool",
    "terrier",
    "githubCli",
  ]),
);
export type DeviceSettingsPatch = typeof DeviceSettingsPatchSchema.Type;

export const WriteDeviceSettingsPayloadSchema = Schema.Struct({
  patch: DeviceSettingsPatchSchema,
});

// Client config: how this app instance looks, kept in clientConfig.json
// under Electron's userData and owned by the main process alone. The
// CLI never reads or writes it, unlike the device config above.
// Doubles as the clientConfig:write IPC input, stripping unknown keys
// at the boundary like GlobalConfigSchema (and with the same
// must-not-become-strict constraint).
export const ClientConfigSchema = Schema.Struct({
  theme: Schema.optional(ThemeSchema),
  // "Animal Crossing" visual mode. Orthogonal to theme: when on, both
  // the light and dark palettes shift to a bolder, color-blocked,
  // Zen-Maru-Gothic-typeset look. On by default (absent = on), explicit
  // `false` is the opt-out back to the v1 look. Mirrored to
  // localStorage so startup paints without a flash.
  doubutsu: Schema.optional(Schema.Boolean),
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
  // engine's own identity for a forward (main/core/portForward/engine.ts
  // dedupes on the same pair). Only preferences that differ from the
  // default (the remote port itself) are stored, so the map stays as
  // small as the user's overrides.
  forwardLocalPorts: Schema.optional(
    Schema.Record(Schema.String, PortNumberSchema),
  ),
  // Legacy: the create-device picks, from before they became a shared
  // setting (shared/sharedSettings.ts, quickCreateDevice). Nothing
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
  // The sidebar's folded projects that have no checkout on this
  // machine, by group key (repo identity, or `${deviceId}/${projectId}`
  // for an identity-less one). A local project's fold is its host's
  // (state.json, host/lib/projects/collapsed.ts). A peer-only project
  // has no host here to keep one, and a hostless client has no host at
  // all, so the window keeps theirs
  // (renderer/hooks/projects/useCollapsedRemoteProjects.ts is the only
  // reader and writer).
  collapsedRemoteProjects: Schema.optional(Schema.Array(Schema.String)),
});
export type ClientConfig = typeof ClientConfigSchema.Type;

// The client config without what was keyed by the account's peers:
// a device leaving the account (a sign-out, a sign-in under another)
// leaves the local port picks, the folded peer projects and the
// legacy create-device picks behind, since every one of them names a
// device of the account that is gone, and a device of a later
// account with the same id must not inherit them.
export function withoutPeerState(config: ClientConfig): ClientConfig {
  const {
    forwardLocalPorts: _forwardLocalPorts,
    collapsedRemoteProjects: _collapsedRemoteProjects,
    quickCreateDevices: _quickCreateDevices,
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

// Per-worktree data IPC payloads construct filesystem paths directly from
// `worktreeId` (unlike other handlers, which route the id through git's
// worktree list first). Constrain it to the exact 12-hex shape that
// `worktreeIdFromPath` produces so a malformed id can't escape the
// projects/<id>/worktrees/ directory.
// The derived worktree id (host/lib/git/worktrees.ts worktreeIdFromPath):
// the first 12 hex chars of the path's sha256. One schema for every
// payload that names one.
const WORKTREE_ID_PATTERN = /^[0-9a-f]{12}$/;
export const WorktreeIdSchema = Schema.String.check(
  Schema.isPattern(WORKTREE_ID_PATTERN),
);

export const ReadWorktreeDataPayloadSchema = Schema.Struct({
  ...ProjectScopedPayloadSchema.fields,
  worktreeId: WorktreeIdSchema,
});

export const WriteWorktreeDataPayloadSchema = Schema.Struct({
  ...ReadWorktreeDataPayloadSchema.fields,
  data: ShigomoriWorktreeDataSchema,
});

// Input to the window module's non-persisting theme preview.
export const PreviewThemePayloadSchema = Schema.Struct({
  theme: ThemeSchema,
});
