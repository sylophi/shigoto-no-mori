// Per-device global config at ~/shigomori[-dev]/config.json. Holds
// preferences that span every project (custom launchers, integrations, …)
// and is kept separate from registry.json (projects, shelf), state.json
// (use logs, sort and collapse preferences) and the per-project configs
// at ~/shigomori[-dev]/projects/<projectId>.json. Appearance is client
// config and lives in main/electron/clientConfig.ts instead.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { errorMessageOf } from "@shared/errors";
import { DEFAULT_SOCKET_PORT } from "@shared/ipc/socket/frames";
import {
  type ClientConfig,
  ClientConfigSchema,
  type GlobalConfig,
  type ReadGlobalConfig,
  StoredGlobalConfigSchema,
} from "@shared/schemas";
import {
  atomicWriteJsonSync,
  readJsonOrNull,
  readJsonOrNullSync,
  withSchemaVersion,
} from "../util/jsonFile";
import { withFileLock } from "../util/lockFile";
import { shigomoriRoot } from "../util/paths";
import { ttlValueCache } from "../util/ttlCache";

function configPath(): string {
  return join(shigomoriRoot(), "config.json");
}

const cache = ttlValueCache<GlobalConfig>(
  5_000,
  async () =>
    (await readJsonOrNull(configPath(), StoredGlobalConfigSchema)) ?? {},
);

export async function readGlobalConfig(): Promise<GlobalConfig> {
  return cache.get();
}

// Config-change reconcilers. Every change path (the IPC write, an
// external CLI write picked up by the state watcher, and nuke wiping
// config.json) drops the cache through invalidateGlobalConfigCache, so
// a listener registered here runs on all of them. Hosting is toggled
// this slice mainly by editing config.json or the CLI (no Settings UI),
// which never touches the IPC write handler, so this subscriber is what
// makes EVERY change reconcile the socket listener, nuke included (a
// wiped config must stop the listener, not keep serving the old token).
// Host owns the mechanism, main registers the one reconciler.
type ConfigChangeListener = () => void;
const configChangeListeners = new Set<ConfigChangeListener>();

export function onGlobalConfigChange(
  listener: ConfigChangeListener,
): () => void {
  configChangeListeners.add(listener);
  return () => configChangeListeners.delete(listener);
}

// For callers that delete config.json out from under the cache (nuke):
// without this, reads for up to the TTL would keep serving the wiped
// preferences as if the nuke hadn't happened. Also fans the change out
// to every subscriber so downstream state (the socket listener)
// reconciles no matter which path changed config.
export function invalidateGlobalConfigCache(): void {
  cache.invalidate();
  for (const listener of configChangeListeners) {
    try {
      listener();
    } catch (error) {
      console.warn(`[config] change listener failed: ${errorMessageOf(error)}`);
    }
  }
}

// The one home for the socketHost enablement rule, shared by the boot
// reconcile, the config-change reconcile and a future Settings UI (the
// githubCli readiness precedent). A blank token means OFF regardless of
// enabled, so a bare enabled:true never opens an unauthenticated
// listener. Absent port falls back to the well-known default, and the
// bind address is loopback unless LAN is explicitly opted in.
export type ResolvedSocketHost = {
  port: number;
  token: string;
  bindAddress: string;
};

export function resolveSocketHostConfig(
  config: GlobalConfig,
): ResolvedSocketHost | null {
  const socketHost = config.socketHost;
  const token = socketHost?.token ?? "";
  if (socketHost?.enabled !== true || token === "") return null;
  return {
    port: socketHost.port ?? DEFAULT_SOCKET_PORT,
    token,
    // Secure by default: only the explicit LAN opt-in exposes the port
    // to the network. Everything else stays on loopback.
    bindAddress: socketHost.lan === true ? "0.0.0.0" : "127.0.0.1",
  };
}

// Secure by default at enable time: when hosting is enabled but no token
// is set, generate a high-entropy one (32 random bytes, base64url) and
// persist it, rather than leaving an enabled-but-unauthable config that
// the resolver treats as off. Runs under the CLI's sibling .lock (the
// takeLegacyAppearance precedent) so app and CLI writes exclude each
// other. Returns true when it wrote, so the caller can re-read. The
// token is NOT logged: retrieve it with `sm config get socketHost.token`
// to copy to the client device. Invalidates the module cache directly
// rather than through the subscriber-firing helper, since the caller is
// already inside a reconcile.
export function ensureSocketHostToken(): boolean {
  const path = configPath();
  return withFileLock(`${path}.lock`, () => {
    const doc = readJsonOrNullSync(path, StoredGlobalConfigSchema);
    if (doc === null) return false;
    const socketHost = doc.socketHost;
    if (socketHost?.enabled !== true) return false;
    const token = typeof socketHost.token === "string" ? socketHost.token : "";
    if (token !== "") return false;
    doc.socketHost = {
      ...socketHost,
      token: randomBytes(32).toString("base64url"),
    };
    atomicWriteJsonSync(path, withSchemaVersion(doc));
    cache.invalidate();
    console.info(
      "[socket] generated a hosting token. Copy it to the client device with `sm config get socketHost.token`.",
    );
    return true;
  });
}

// Read-boundary redaction: a secret never crosses any wire. socketHost
// keeps its shape minus the token (a derived tokenSet boolean stands
// in), and remoteDevices is dropped WHOLESALE: the outbound device list
// (urls, labels, tokens this client holds to reach other hosts) is
// private connect config, so a remote peer calling this read learns
// none of it. Both are served over the SAME remote-tagged read, so both
// are stripped here rather than only in the schema: packaged builds skip
// output re-parsing, so the read schema alone would not strip them in
// production.
export function redactGlobalConfigForRead(
  config: GlobalConfig,
): ReadGlobalConfig {
  const { socketHost, remoteDevices: _remoteDevices, ...rest } = config;
  const redacted: ReadGlobalConfig = { ...rest };
  if (socketHost !== undefined) {
    const { token, ...withoutToken } = socketHost;
    redacted.socketHost = {
      ...withoutToken,
      tokenSet: typeof token === "string" && token !== "",
    };
  }
  return redacted;
}

// One-shot drain of the pre-split appearance keys out of config.json,
// for the client config migration (main/electron/clientConfigMigration.ts).
// Extracts theme and doubutsu, deletes them from the doc, writes it
// back with every other key intact and schemaVersion restamped, and
// returns what it found. Runs under the same sibling .lock the CLI's
// updateConfigDoc takes (cli/cmd_config.go, host/lib/util/lockFile.ts),
// so app and CLI writes exclude each other. Sync because the caller
// sits on the boot path before the first window. Throws when
// config.json is unreadable, and the caller skips the drain for that
// boot.
export function takeLegacyAppearance(): ClientConfig {
  const path = configPath();
  return withFileLock(`${path}.lock`, () => {
    const doc = readJsonOrNullSync(path, StoredGlobalConfigSchema);
    if (doc === null) return {};
    const taken: ClientConfig = {};
    // Field by field so one bad value can't void the other. An invalid
    // value is still drained below: the store's defaults are the right
    // replacement for a value no build could read.
    const theme = ClientConfigSchema.shape.theme.safeParse(doc["theme"]);
    if (theme.success && theme.data !== undefined) taken.theme = theme.data;
    const doubutsu = ClientConfigSchema.shape.doubutsu.safeParse(
      doc["doubutsu"],
    );
    if (doubutsu.success && doubutsu.data !== undefined) {
      taken.doubutsu = doubutsu.data;
    }
    // Nothing to delete means nothing to write: a fresh install's
    // config.json passes through untouched.
    if (!("theme" in doc) && !("doubutsu" in doc)) return taken;
    delete doc["theme"];
    delete doc["doubutsu"];
    atomicWriteJsonSync(path, withSchemaVersion(doc));
    cache.invalidate();
    return taken;
  });
}
