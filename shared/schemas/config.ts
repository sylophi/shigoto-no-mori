import { z } from "zod";
import { isSafeRelPath } from "../gitPaths";
import { ProjectScopedPayloadSchema } from "./payloads";
import { MergeMethodSchema } from "./pullRequest";

export const ThemeSchema = z.enum(["light", "dark", "system"]);
export type Theme = z.infer<typeof ThemeSchema>;

export const LauncherCommandSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  command: z.string().min(1),
});
export type LauncherCommand = z.infer<typeof LauncherCommandSchema>;

// A remote device this client connects OUT to over the websocket host
// transport (v2 step 3, slice B). Hand-typed this slice: the host's
// ws:// url plus the shared token it serves. Step 4 replaces the token
// with pairing, so nothing else should grow to depend on the token's
// shape. `token` is a secret this client holds to reach the host, so it
// is redacted out of a read exactly like socketHost.token (see
// RedactedRemoteDeviceSchema below): it must never ride out on a read a
// remote peer can call.
export const RemoteDeviceEntrySchema = z.object({
  label: z.string().optional(),
  url: z.string(),
  token: z.string(),
});
export type RemoteDeviceEntry = z.infer<typeof RemoteDeviceEntrySchema>;

// Files/folders to carry over from the primary checkout into newly-created
// worktrees. `path` is relative to the project root; gitignored entries are
// the expected source. `symlink` keeps state shared; `copy` snapshots.
export const CarryOverEntrySchema = z.object({
  path: z.string().min(1).refine(isSafeRelPath, {
    message: "Path must stay within the project root",
  }),
  mode: z.enum(["copy", "symlink"]),
});
export type CarryOverEntry = z.infer<typeof CarryOverEntrySchema>;

// Where shigomori's managed worktrees for this project live on disk.
// - managed-root: ~/shigomori[-dev]/worktrees/<projectName>/<worktreeName>
//   (default; one place for every project's worktrees, easy to nuke)
// - in-project: <projectPath>/.shigomori/worktrees/<worktreeName>
//   (sits inside the primary; lets tools that walk up to a workspace
//   root, like Turbopack, accept symlinked node_modules from carry-over)
// - custom: <customWorktreePath>/<worktreeName>
//   (escape hatch; not recommended -- can collide with other repos and
//   complicates external-vs-managed detection)
export const WorktreeLayoutSchema = z.enum([
  "managed-root",
  "in-project",
  "custom",
]);
export type WorktreeLayout = z.infer<typeof WorktreeLayoutSchema>;

// Per-project config. Stored at ~/shigomori[-dev]/projects/<projectId>.json
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
});
export type ShigomoriConfig = z.infer<typeof ShigomoriConfigSchema>;

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

// Per-worktree persistent data. Only kept for shigomori-managed worktrees;
// external worktrees deliberately have no on-disk state.
export const ShigomoriWorktreeDataSchema = z.object({
  notes: z.string().optional(),
});
export type ShigomoriWorktreeData = z.infer<typeof ShigomoriWorktreeDataSchema>;

// Global, per-device config kept in ~/shigomori[-dev]/config.json. Holds
// preferences that span every project: custom launchers the user wants
// everywhere (claude, tmux, an editor command, etc.), and room for future
// settings.
// Device config only: every key here gates what this machine can do,
// so both the host and the CLI read it. How the app instance looks
// (theme, doubutsu) is client config and lives in ClientConfigSchema
// below.
// Doubles as the globalConfig:write IPC input. z.object STRIPS unknown
// keys rather than rejecting them, and it must not become .strict():
// pre-split installs can still carry legacy client keys (and keys from
// newer builds) in config.json, and those have to keep passing through
// the write path unrejected. The stripping is also what drops a key
// the renderer invents at the boundary instead of persisting it.
export const GlobalConfigSchema = z.object({
  launchers: z.array(LauncherCommandSchema).optional(),
  // Launcher entry ids (`app:cursor`, `web:github`, `custom:<uuid>`) the
  // user has switched off, so they're skipped when building a project's
  // launcher row -- and therefore also absent from the File menu's
  // ⌘1..⌘9, which mirrors the row. Everything is shown by default;
  // absent = nothing hidden. Ids that no longer resolve (an app the user
  // uninstalled, a deleted custom tool) simply never match and are
  // harmless to keep.
  hiddenLaunchers: z.array(z.string()).optional(),
  // When true, the Launch section carries a second row of the worktree's
  // top package.json scripts -- as many as fit on one line, ordered by the
  // project's script sort. On by default; absent = on, explicit `false` is
  // the opt-out.
  launchScripts: z.boolean().optional(),
  // When false, deleting a worktree keeps its checked-out local branch
  // (deletion is skipped anyway if the branch is the primary's or in
  // use by another worktree). ON by default -- unset means delete, in
  // both engines (cli/cmd_config.go and host/lib/nuke.ts).
  deleteBranchOnRemove: z.boolean().optional(),
  // When true, adding a project with a package.json seeds its setup
  // script with `<detected-pm> install`. Only fires at project-add
  // time; existing projects are untouched.
  autoPopulateInstall: z.boolean().optional(),
  // When true, projects with a valid port-pool.config.json run
  // `port-pool provision` after setup at create and
  // `port-pool release` before teardown at delete.
  portPool: z.boolean().optional(),
  // When true, GitHub CLI features light up wherever they apply.
  // Activates only when `gh` is on PATH and authenticated. On by
  // default; matches the integration being opt-out rather than opt-in.
  githubCli: z.boolean().optional(),
  // Remote hosting (v2 step 3, slice A): when enabled with a nonempty
  // token, the app serves the REMOTE-tagged host IPC to clients over a
  // websocket (host/socket/server.ts). Off by default, and gated on the
  // token so a bare `enabled: true` can never open an unauthenticated
  // listener. Secure by default: enabling binds LOOPBACK only. Exposing
  // the port to the network is a separate explicit opt-in (`lan`). The
  // token is high-entropy generated at enable time, never echoed back
  // over a read (the read contract redacts it, see RedactedSocketHost
  // below). Step 4 replaces this shared-token auth wholesale with
  // pairing, so nothing else should grow to depend on the token's shape.
  socketHost: z
    .object({
      enabled: z.boolean().optional(),
      // Absent = DEFAULT_SOCKET_PORT (shared/ipc/socket/frames.ts).
      port: z.number().int().min(1).max(65535).optional(),
      // When true, bind 0.0.0.0 so other machines on the LAN can reach
      // the listener. Absent or false binds 127.0.0.1: enabling hosting
      // alone never exposes the port to the network.
      lan: z.boolean().optional(),
      token: z.string().optional(),
    })
    .optional(),
  // Remote devices this client connects OUT to (v2 step 3, slice B).
  // The renderer's device registry reconciles its live socket
  // connections against this list. Each entry carries a token secret,
  // redacted out of the read (see ReadGlobalConfigSchema). Absent = no
  // remote devices.
  remoteDevices: z.array(RemoteDeviceEntrySchema).optional(),
});
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

// Read-side counterpart, loose like StoredShigomoriConfigSchema.
export const StoredGlobalConfigSchema = GlobalConfigSchema.loose();

// The socketHost shape a globalConfig READ is allowed to return. The
// token is a secret and must be structurally absent from any wire, so
// this schema has no token field at all. A derived `tokenSet` boolean
// lets a future Settings UI show that hosting is configured without
// ever carrying the value. The redaction itself happens in the read
// handler (host/lib/config/global.ts), since packaged builds skip
// output re-parsing, so this schema documents and validates the shape
// rather than being the thing that strips the secret.
export const RedactedSocketHostSchema = z.object({
  enabled: z.boolean().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  lan: z.boolean().optional(),
  tokenSet: z.boolean().optional(),
});
export type RedactedSocketHost = z.infer<typeof RedactedSocketHostSchema>;

// Output schema for globalConfig:read. Loose like the stored variant so
// legacy and newer keys pass through, but with socketHost forced to the
// redacted shape so a token can never ride out on a read. remoteDevices
// is dropped ENTIRELY from a read (not just its tokens): the outbound
// device list is this client's private connect config, so a remote peer
// calling this read learns nothing about which other hosts this client
// reaches. The renderer's device registry reads that list from a local
// unredacted path, never this wire.
export const ReadGlobalConfigSchema = GlobalConfigSchema.omit({
  remoteDevices: true,
})
  .extend({
    socketHost: RedactedSocketHostSchema.optional(),
  })
  .loose();
export type ReadGlobalConfig = z.infer<typeof ReadGlobalConfigSchema>;

export const WriteGlobalConfigPayloadSchema = z.object({
  config: GlobalConfigSchema,
});

// Client config: how this app instance looks, kept in clientConfig.json
// under Electron's userData and owned by the main process alone. The
// CLI never reads or writes it, unlike the device config above.
// Doubles as the clientConfig:write IPC input, stripping unknown keys
// at the boundary like GlobalConfigSchema (and with the same
// must-not-become-.strict() constraint).
export const ClientConfigSchema = z.object({
  theme: ThemeSchema.optional(),
  // "Animal Crossing" visual mode. Orthogonal to theme: when on, both
  // the light and dark palettes shift to a bolder, color-blocked,
  // Zen-Maru-Gothic-typeset look. On by default (absent = on), explicit
  // `false` is the opt-out back to the v1 look. Mirrored to
  // localStorage so startup paints without a flash.
  doubutsu: z.boolean().optional(),
  // "Keep this device reachable": the single opt-in behind two liveness
  // capabilities the main process reconciles (main/electron/liveness.ts).
  // When on, the app registers a login item so it starts when the user
  // logs in, and it best-effort relaunches itself after a recoverable
  // crash so a machine the user hosts stays online for the account
  // relay. Per-machine and never synced, like the rest of client config:
  // the CLI never reads it and it does not ride any sync path. Default is
  // off (absent = off), explicit `true` is the opt-in.
  keepReachable: z.boolean().optional(),
});
export type ClientConfig = z.infer<typeof ClientConfigSchema>;

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
const WorktreeIdSchema = z.string().regex(/^[0-9a-f]{12}$/);

export const ReadWorktreeDataPayloadSchema = ProjectScopedPayloadSchema.extend({
  worktreeId: WorktreeIdSchema,
});

export const WriteWorktreeDataPayloadSchema =
  ReadWorktreeDataPayloadSchema.extend({
    data: ShigomoriWorktreeDataSchema,
  });

// Input to the window module's non-persisting theme preview.
export const PreviewThemePayloadSchema = z.object({
  theme: ThemeSchema,
});
