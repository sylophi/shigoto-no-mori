import { useMutation } from "@tanstack/react-query";
import {
  type ClientConfig,
  type DeviceSettingsPatch,
  type LauncherCommand,
} from "@shigomori/contracts/schemas";
import { storedClientSetting } from "@shigomori/contracts/schemas/config";
import { storedPicks } from "@shigomori/ui/lib/themes.ts";
import { errorMessageOf } from "@shigomori/contracts/errors";
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

// Appearance saves through the client-scoped store, each key omitted
// at its default.
export function toClientConfig(state: SettingsFormState): ClientConfig {
  return {
    theme: storedClientSetting("theme", state.theme),
    doubutsu: storedClientSetting("doubutsu", state.doubutsu),
    // Kept while the switch is off, so they come back with it.
    ...storedPicks(state.lightTheme, state.darkTheme),
    themeRotation: state.themeRotation ? state.themeRotationEvery : undefined,
    pauseAnimationsOnBattery: storedClientSetting(
      "pauseAnimationsOnBattery",
      state.pauseAnimationsOnBattery,
    ),
    villageLife: storedClientSetting("villageLife", state.villageLife),
    villageNews: storedClientSetting("villageNews", state.villageNews),
    markTerrierProjects: storedClientSetting(
      "markTerrierProjects",
      state.markTerrierProjects,
    ),
    showDeviceBadges: storedClientSetting(
      "showDeviceBadges",
      state.showDeviceBadges,
    ),
    allowAgentWorking: storedClientSetting(
      "allowAgentWorking",
      state.allowAgentWorking,
    ),
    markAgentsWaiting: storedClientSetting(
      "markAgentsWaiting",
      state.markAgentsWaiting,
    ),
    notifyAgentWaiting: storedClientSetting(
      "notifyAgentWaiting",
      state.notifyAgentWaiting,
    ),
    notifyAgentDone: storedClientSetting(
      "notifyAgentDone",
      state.notifyAgentDone,
    ),
    inlineWorktrees: storedClientSetting(
      "inlineWorktrees",
      state.inlineWorktrees,
    ),
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

// What a peer's Save writes: the device keys its form changed from what
// it last saved.
export function peerSettingsWrite(
  saved: SettingsFormState,
  state: SettingsFormState,
): DeviceSettingsPatch {
  return changedKeys(
    toDeviceSettingsPatch(saved),
    toDeviceSettingsPatch(state),
  );
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
  return useMutation({
    mutationFn: async ({
      state,
      saved,
    }: {
      state: SettingsFormState;
      saved: SettingsFormState;
    }): Promise<void> => {
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
          // A pick or a rotation saved here starts a timed rotation's
          // period over.
          const restartsRotation = [
            "lightTheme",
            "darkTheme",
            "themeRotation",
          ].some((key) => key in clientPatch);
          await patchClientConfig(
            page,
            registry,
            restartsRotation
              ? { ...clientPatch, themeRotatedAt: Date.now() }
              : clientPatch,
          );
        } catch (error) {
          throw new SettingsSaveError(devicePersisted, error);
        }
      }
    },
    meta: { errorTitle: "Couldn't save settings" },
  });
}
