import {
  type QueryClient,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  type ClientConfig,
  type DeviceSettingsPatch,
  type LauncherCommand,
} from "@shigomori/contracts/schemas";
import {
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
} from "@shigomori/ui/lib/themes.ts";
import { errorMessageOf } from "@shigomori/contracts/errors";
import { queryKeysFor, type QueryKeyRegistry } from "@/lib/queryKeys";
import { patchClientConfig } from "./useClientConfig";
import { useRegistry } from "@/lib/runtime/viewHooks";
import type { SettingsFormState } from "@shigomori/ui/lib/settingsForm.ts";
import { useApi } from "@/lib/runtime/pageApi";

// A launcher row persists only once both halves are filled in.
// Half-typed rows live purely in form state. Shared by the encoders so
// local and remote saves agree on what a saveable launcher is.
function validLaunchers(state: SettingsFormState): LauncherCommand[] {
  return state.launchers.filter(
    (l) => l.label.trim().length > 0 && l.command.trim().length > 0,
  );
}

// The peer encoding: the globalConfig.writeDeviceSettings patch,
// carrying ONLY the keys a peer's Settings section edits. The host
// applies the patch as absent-means-keep, which is what keeps the
// launch catalog (launchers, hiddenLaunchers, launchScripts, terminal,
// editor) out of it: those keys are local by nature and edited only on
// this machine's Launch tools section, so a peer save must not re-send a
// snapshot of them taken when the peer's form was seeded. Every key
// carries an EXPLICIT value, default included: absent means keep, so
// only an explicit default reverts a key (the host then stores it by
// omission).
export function toDeviceSettingsPatch(
  state: SettingsFormState,
): DeviceSettingsPatch {
  return {
    deleteBranchOnRemove: state.deleteBranchOnRemove,
    autoPopulateInstall: state.autoPopulateInstall,
    autoPullNew: state.autoPullNew,
    autoPullPrimaryOnly: state.autoPullPrimaryOnly,
    autoShelveDays: state.autoShelveDays,
    doubutsuNames: state.doubutsuNames,
    codexWorktreeNames: state.codexWorktreeNames,
    managedOnProjectDrive: state.managedOnProjectDrive,
    portPool: state.portPool,
    terrier: state.terrier,
    githubCli: state.githubCli,
  };
}

// This machine's encoding: the peer patch plus the launch catalog,
// which this window's Launch tools section edits. Also the dirty
// projection, so an unchanged device half skips the device write.
function toLocalDeviceSettingsPatch(
  state: SettingsFormState,
): DeviceSettingsPatch {
  return {
    ...toDeviceSettingsPatch(state),
    launchers: validLaunchers(state),
    hiddenLaunchers: state.hiddenLaunchers,
    launchScripts: state.launchScripts,
    terminal: state.terminal,
    editor: state.editor,
  };
}

// Appearance saves through the client-scoped store, not the device
// config, omitting a key at its default to keep the file tidy.
export function toClientConfig(state: SettingsFormState): ClientConfig {
  return {
    // Default is "system"; omit when on the default to keep the file tidy.
    theme: state.theme === "system" ? undefined : state.theme,
    // Default is on; omit when on, store explicit `false` when off so
    // the user's opt-out survives reads (same as deleteBranchOnRemove).
    doubutsu: state.doubutsu ? undefined : false,
    // Each pick is omitted at its list's default, and kept while the
    // switch is off so it comes back with it.
    lightTheme:
      state.lightTheme === DEFAULT_LIGHT_THEME ? undefined : state.lightTheme,
    darkTheme:
      state.darkTheme === DEFAULT_DARK_THEME ? undefined : state.darkTheme,
    // Default is on, with the same opt-out serialization as doubutsu.
    pauseAnimationsOnBattery: state.pauseAnimationsOnBattery
      ? undefined
      : false,
    // Default is off, so off is omitted and the opt-in stored as `true`.
    villageLife: state.villageLife ? true : undefined,
    // Default is on, with the same opt-out serialization as doubutsu.
    villageNews: state.villageNews ? undefined : false,
    // Default is off, the same opt-in serialization as villageLife.
    markTerrierProjects: state.markTerrierProjects ? true : undefined,
    // Default is on, with the same opt-out serialization as doubutsu.
    showDeviceBadges: state.showDeviceBadges ? undefined : false,
    // Default is off, the same opt-in serialization as villageLife.
    allowAgentWorking: state.allowAgentWorking ? true : undefined,
    // Default is on, with the same opt-out serialization as doubutsu.
    markAgentsWaiting: state.markAgentsWaiting ? undefined : false,
    notifyAgentWaiting: state.notifyAgentWaiting ? undefined : false,
    // Default is off, the same opt-in serialization as villageLife.
    notifyAgentDone: state.notifyAgentDone ? true : undefined,
    // Default is off, the same opt-in serialization as villageLife.
    inlineWorktrees: state.inlineWorktrees ? true : undefined,
    // Only an action bound off its default is stored, so none is nothing.
    keybindings:
      Object.keys(state.keybindings).length > 0 ? state.keybindings : undefined,
  };
}

// What a Save writes: each store's keys the form changed from what it
// last saved, nothing else.
export function settingsWrites(
  saved: SettingsFormState,
  state: SettingsFormState,
): { devicePatch: DeviceSettingsPatch; clientPatch: Partial<ClientConfig> } {
  return {
    devicePatch: changedKeys(
      toLocalDeviceSettingsPatch(saved),
      toLocalDeviceSettingsPatch(state),
    ),
    clientPatch: changedKeys(toClientConfig(saved), toClientConfig(state)),
  };
}

// The keys of `now` that differ from `was`, a key gone from `now`
// given as undefined (its default, stored by omission).
function changedKeys<T extends object>(was: T, now: T): Partial<T> {
  const changed: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(was), ...Object.keys(now)]);
  for (const key of keys) {
    const before = (was as Record<string, unknown>)[key];
    const after = (now as Record<string, unknown>)[key];
    if (JSON.stringify(before) !== JSON.stringify(after)) changed[key] = after;
  }
  return changed as Partial<T>;
}

// Thrown when the appearance write fails after the device write
// already landed (writes run device first). Carries which half
// persisted so the form can advance its snapshot for the half that
// did.
export class SettingsSaveError extends Error {
  readonly devicePersisted: boolean;
  constructor(devicePersisted: boolean, cause: unknown) {
    const suffix = devicePersisted ? " The other settings were saved." : "";
    super(
      `Appearance settings couldn't be saved: ${errorMessageOf(cause)}.${suffix}`,
      { cause },
    );
    this.name = "SettingsSaveError";
    this.devicePersisted = devicePersisted;
  }
}

interface SettingsSaveResult {
  devicePersisted: boolean;
  clientPersisted: boolean;
}

// What a device-settings write stales, for whichever device's registry
// it is handed: the local save below passes the LOCAL keys (it writes
// through the page's api, so the caches it staled are exactly this
// machine's), and useDeviceSettingsSave passes the scoped registry of
// the peer it patched.
// The config itself, the projects and the worktree lists are the host's
// views, which read the device config again themselves (terrier's
// projects, Codex-style names, the idle shelf).
export function invalidateDeviceSettingsQueries(
  queryClient: QueryClient,
  keys: QueryKeyRegistry,
): void {
  // Launcher catalogs for every project depend on global custom launchers.
  void queryClient.invalidateQueries({ queryKey: keys.launchersAll() });
  // Toggling the GitHub CLI integration flips both readiness gating
  // and the project PR list -- refetch immediately rather than wait
  // for the next focus/mount.
  void queryClient.invalidateQueries({ queryKey: keys.githubCliAll() });
}

// One Save over two stores, as ONE mutation so isPending, isSuccess and
// error reset atomically per save (two mutations left a failed half's
// error sticky across later successful saves). Each store is sent only
// the keys the form changed from what it last saved (`saved`), so a
// form seeded while a read was failing, or before another window
// changed a key, never writes back what it did not change. A store
// with nothing changed is not written.
// Writes run device first, then client, sequentially: a device failure
// persists nothing, and a client failure after a landed device write
// throws SettingsSaveError so the form can advance the persisted half.
export function useSettingsSave() {
  const page = useApi();
  const registry = useRegistry();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      state,
      saved,
    }: {
      state: SettingsFormState;
      saved: SettingsFormState;
    }): Promise<SettingsSaveResult> => {
      const { devicePatch, clientPatch } = settingsWrites(saved, state);
      const devicePersisted = Object.keys(devicePatch).length > 0;
      const clientPersisted = Object.keys(clientPatch).length > 0;
      if (devicePersisted) {
        // The same patch write a peer's save rides, on this machine's
        // own api: the host applies it over the stored document under
        // its config write lock, absent keys kept.
        await page.run(
          page.globalConfig.writeDeviceSettings({ patch: devicePatch }),
        );
      }
      if (clientPersisted) {
        try {
          await patchClientConfig(page, registry, clientPatch);
        } catch (error) {
          throw new SettingsSaveError(devicePersisted, error);
        }
      }
      return { devicePersisted, clientPersisted };
    },
    onSuccess: ({ devicePersisted }) => {
      if (devicePersisted) {
        invalidateDeviceSettingsQueries(
          queryClient,
          queryKeysFor(page.deviceId),
        );
      }
    },
    onError: (error) => {
      // A SettingsSaveError with devicePersisted means the device write
      // landed before the appearance write failed, so its caches are
      // stale exactly as on success.
      if (error instanceof SettingsSaveError && error.devicePersisted) {
        invalidateDeviceSettingsQueries(
          queryClient,
          queryKeysFor(page.deviceId),
        );
      }
    },
    meta: { errorTitle: "Couldn't save settings" },
  });
}
