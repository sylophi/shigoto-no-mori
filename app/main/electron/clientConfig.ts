// The client config store: clientConfig.json in Electron's userData.
// Client config is how this app instance looks (theme, palettes).
// Device config in the shigomori root gates what a machine can do and
// stays with the host and the CLI. This file is owned by the main
// process alone and the CLI never touches it.
//
// Read once as the shell's graph comes up (layer below), which the boot
// waits on before its first window: the saved theme is applied before
// the BrowserWindow exists (main/index.ts, via applyThemeSource below),
// which is what keeps the vibrancy material from flashing the wrong
// variant on first paint. Reads after that are this module's memory,
// which every window watches (clientConfig:watch), and writes go
// through FileSystem.
import { join } from "node:path";
import { app, nativeTheme } from "electron";
import { clientSetting } from "@shigomori/contracts/schemas/config";
import { rotationOwner } from "@shigomori/ui/lib/themes.ts";
import * as Clock from "effect/Clock";
import type * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  type ClientConfig,
  ClientConfigSchema,
  StoredClientConfigSchema,
  type Theme,
} from "@shigomori/contracts/schemas";
import { log } from "@shared/log";
import { readJson, writeJson } from "../core/files/jsonFile";

function clientConfigPath(): string {
  return join(app.getPath("userData"), "clientConfig.json");
}

// This module is the store's only writer, so what it read is valid
// until the next writeClientConfig in this process updates it.
const memo = Effect.runSync(SubscriptionRef.make<ClientConfig>({}));

// A store that stays broken is hit on every boot and every save, so
// warn once per file per run instead of never (a silent catch turns
// corruption into a default reset with nothing in the console).
const corruptStoreNoted = new Set<string>();

function noteCorruptStore(file: string, error: unknown): void {
  if (corruptStoreNoted.has(file)) return;
  corruptStoreNoted.add(file);
  log.warn(`[clientConfig] ${file} unreadable, falling back:`, error);
}

// Corrupt or unreadable content reads as empty defaults, as an absent
// file does, so a broken store never blocks startup.
const readStoredDoc = Effect.suspend(() =>
  readJson(clientConfigPath(), StoredClientConfigSchema),
).pipe(
  Effect.map((doc): Record<string, unknown> => doc ?? {}),
  Effect.catchTags({
    JsonFileError: (error) =>
      Effect.sync(() => {
        noteCorruptStore(error.path, error.cause);
        return {};
      }),
  }),
);

// The platform the reads and writes run on, once the shell's graph has
// built the layer below.
const platform =
  Deferred.makeUnsafe<Context.Context<FileSystem.FileSystem | Path.Path>>();

// Read, and the platform kept for the writes. The boot waits on it
// (clientConfigRead) before its first window.
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* SubscriptionRef.set(memo, (yield* readStoredDoc) as ClientConfig);
    yield* Deferred.succeed(
      platform,
      yield* Effect.context<FileSystem.FileSystem | Path.Path>(),
    );
  }),
);

// Settles once the layer above has read the store.
export const clientConfigRead = (): Promise<void> =>
  Effect.runPromise(Effect.asVoid(Deferred.await(platform)));

export function readClientConfigSync(): ClientConfig {
  return SubscriptionRef.getUnsafe(memo);
}

// The config now, then each one written.
export const clientConfigChanges: Stream.Stream<ClientConfig> =
  SubscriptionRef.changes(memo);

// Merge-on-write: read the on-disk doc loosely, drop only the keys this
// build models, overlay the incoming ones, write atomically.
// A full replace would erase keys a newer build wrote. Omission of a
// modeled key still clears it (the omit-on-default serialization).
// Corruption merges over {} instead (warned once above), the same
// default reset the read side applies.
const write = Effect.fnUntraced(function* (config: ClientConfig) {
  const onDisk = yield* readStoredDoc;
  const merged: Record<string, unknown> = { ...onDisk };
  for (const key of Object.keys(ClientConfigSchema.fields)) {
    delete merged[key];
  }
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined) merged[key] = value;
  }
  yield* writeJson(clientConfigPath(), merged);
  yield* SubscriptionRef.set(memo, config);
});

// One change at a time, each over the config the last one left, so two
// windows' patches (or two in flight from one) keep each other's keys.
const changes = Semaphore.makeUnsafe(1);

// The config as `change` makes it from the one standing, written: over
// the stored config, never the empty one standing in for it before the
// boot has read it.
const update = (change: (config: ClientConfig) => ClientConfig) =>
  Effect.gen(function* () {
    const context = yield* Deferred.await(platform);
    const before = yield* SubscriptionRef.get(memo);
    const after = change(before);
    if (after !== before) yield* Effect.provideContext(write(after), context);
    return { before, after };
  }).pipe(changes.withPermits(1));

export const updateClientConfig = (
  change: (config: ClientConfig) => ClientConfig,
): Promise<{ readonly before: ClientConfig; readonly after: ClientConfig }> =>
  Effect.runPromise(update(change));

// A window's patch (clientConfig:patch): its keys set or cleared over
// the config as it stands.
export function patchClientConfig(
  set: ClientConfig,
  clear: ReadonlyArray<keyof ClientConfig>,
) {
  return updateClientConfig((before) => {
    const after: Record<string, unknown> = { ...before };
    for (const [key, value] of Object.entries(set)) {
      if (value !== undefined) after[key] = value;
    }
    for (const key of clear) delete after[key];
    return after as ClientConfig;
  });
}

// The palette rotation (clientConfig:rotate), owned here so the
// windows' checks turn it once, and the launch's turn once per run of
// the app.
const rotationTurnOf = rotationOwner();
export const rotatePalette = (launching: boolean): Promise<number | null> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const { before, after } = yield* update((config) => {
        const turn = rotationTurnOf(config, now, launching);
        return turn ? { ...config, ...turn } : config;
      });
      return after === before ? null : now;
    }),
  );

// The one place nativeTheme.themeSource is set. Boot and the window module's
// previewTheme both land here. A clientConfig patch deliberately does
// not: the renderer's preview effect has always applied the staged
// theme by the time a save lands, so an apply-on-write could only ever
// override the screen with a stale value.
export function applyThemeSource(theme: Theme | undefined): void {
  nativeTheme.themeSource = clientSetting({ theme }, "theme");
}
