import {
  type QueryClient,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  type ClientConfig,
  DEVICE_SETTINGS_DEFAULTS as DEFAULTS,
  type DeviceSettingsPatch,
  type GlobalConfig,
  type LauncherCommand,
  type Theme,
} from "@shared/schemas";
import { errorMessageOf } from "@shared/errors";
import { queryKeys, type QueryKeyRegistry } from "@/lib/queryKeys";
import { mergeClientConfigWrite } from "./mergeClientConfigWrite";

// The settings form's staged state. One flat shape across both stores:
// the first three fields are client config (appearance), the rest are
// device config.
export interface SettingsFormState {
  theme: Theme;
  doubutsu: boolean;
  pauseAnimationsOnBattery: boolean;
  launchers: LauncherCommand[];
  hiddenLaunchers: string[];
  launchScripts: boolean;
  deleteBranchOnRemove: boolean;
  autoPopulateInstall: boolean;
  autoPullNew: boolean;
  autoPullPrimaryOnly: boolean;
  doubutsuNames: boolean;
  // The stored value, shown as is while doubutsuNames is off (the row
  // is disabled then). Whether villager extras show is
  // villageLifeEnabled's call, never this field alone.
  villageLife: boolean;
  codexWorktreeNames: boolean;
  portPool: boolean;
  terrier: boolean;
  githubCli: boolean;
}

// Decode lives beside the encoders so encode, decode and the dirty
// diff below share one file. Device defaults come from the shared table
// the host's patch write stores by omission, never respelled here.
export function fromConfig(
  config: GlobalConfig,
  clientConfig: ClientConfig,
): SettingsFormState {
  return {
    theme: clientConfig.theme ?? "system",
    doubutsu: clientConfig.doubutsu ?? true,
    pauseAnimationsOnBattery: clientConfig.pauseAnimationsOnBattery ?? true,
    launchers: config.launchers ?? [],
    // Sorted here and on every toggle so the id list has one canonical
    // order. useDirtyForm compares FormState by JSON.stringify, and
    // hiding is set-semantic -- without this, re-hiding a tool in a
    // different order would read as an unsaved change.
    hiddenLaunchers: (config.hiddenLaunchers ?? []).toSorted(),
    launchScripts: config.launchScripts ?? DEFAULTS.launchScripts,
    deleteBranchOnRemove:
      config.deleteBranchOnRemove ?? DEFAULTS.deleteBranchOnRemove,
    autoPopulateInstall:
      config.autoPopulateInstall ?? DEFAULTS.autoPopulateInstall,
    autoPullNew: config.autoPullNew ?? DEFAULTS.autoPullNew,
    autoPullPrimaryOnly:
      config.autoPullPrimaryOnly ?? DEFAULTS.autoPullPrimaryOnly,
    doubutsuNames: config.doubutsuNames ?? DEFAULTS.doubutsuNames,
    villageLife: config.villageLife ?? DEFAULTS.villageLife,
    codexWorktreeNames:
      config.codexWorktreeNames ?? DEFAULTS.codexWorktreeNames,
    portPool: config.portPool ?? DEFAULTS.portPool,
    terrier: config.terrier ?? DEFAULTS.terrier,
    githubCli: config.githubCli ?? DEFAULTS.githubCli,
  };
}

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
// launch catalog (launchers, hiddenLaunchers, launchScripts) out of it:
// those keys are local by nature and edited only on this machine's
// Launch tools section, so a peer save must not re-send a snapshot of
// them taken when the peer's form was seeded. Every key carries an
// EXPLICIT value, default included: absent means keep, so only an
// explicit default reverts a key (the host then stores it by omission).
export function toDeviceSettingsPatch(
  state: SettingsFormState,
): DeviceSettingsPatch {
  return {
    deleteBranchOnRemove: state.deleteBranchOnRemove,
    autoPopulateInstall: state.autoPopulateInstall,
    autoPullNew: state.autoPullNew,
    autoPullPrimaryOnly: state.autoPullPrimaryOnly,
    doubutsuNames: state.doubutsuNames,
    villageLife: state.villageLife,
    codexWorktreeNames: state.codexWorktreeNames,
    portPool: state.portPool,
    terrier: state.terrier,
    githubCli: state.githubCli,
  };
}

// This machine's encoding: the peer patch plus the launch catalog,
// which this window's Launch tools section edits. Also the dirty
// projection, so an unchanged device half skips the CLI spawn.
function toLocalDeviceSettingsPatch(
  state: SettingsFormState,
): DeviceSettingsPatch {
  return {
    ...toDeviceSettingsPatch(state),
    launchers: validLaunchers(state),
    hiddenLaunchers: state.hiddenLaunchers,
    launchScripts: state.launchScripts,
  };
}

// Appearance saves through the client-scoped store, not the device
// config, omitting a key at its default to keep the file tidy.
function toClientConfig(state: SettingsFormState): ClientConfig {
  return {
    // Default is "system"; omit when on the default to keep the file tidy.
    theme: state.theme === "system" ? undefined : state.theme,
    // Default is on; omit when on, store explicit `false` when off so
    // the user's opt-out survives reads (same as deleteBranchOnRemove).
    doubutsu: state.doubutsu ? undefined : false,
    // Default is on, with the same opt-out serialization as doubutsu.
    pauseAnimationsOnBattery: state.pauseAnimationsOnBattery
      ? undefined
      : false,
  };
}

// The docs are canonical by construction (one encoder, undefined keys
// dropped by JSON.stringify), so equal serializations mean an
// unchanged store.
function serialize(doc: DeviceSettingsPatch | ClientConfig): string {
  return JSON.stringify(doc);
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
  clientConfig: ClientConfig;
}

// What a device-settings write stales, for whichever device's registry
// it is handed: the local save below passes the LOCAL keys (it writes
// through window.api, so the caches it staled are exactly this
// machine's), and useDeviceSettingsSave passes the scoped registry of
// the peer it patched.
export function invalidateDeviceSettingsQueries(
  queryClient: QueryClient,
  keys: QueryKeyRegistry,
  worktreeNamesChanged: boolean,
): void {
  void queryClient.invalidateQueries({ queryKey: keys.globalConfig() });
  // Launcher catalogs for every project depend on global custom launchers.
  void queryClient.invalidateQueries({ queryKey: keys.launchersAll() });
  // Toggling the GitHub CLI integration flips both readiness gating
  // and the project PR list -- refetch immediately rather than wait
  // for the next focus/mount.
  void queryClient.invalidateQueries({ queryKey: keys.githubCliAll() });
  // Toggling the terrier integration changes which projects the
  // list handler merges in -- same immediate refetch. (Terrier
  // readiness depends only on the binary, not the toggle, so it
  // has nothing to invalidate here.)
  void queryClient.invalidateQueries({ queryKey: keys.projects() });
  // Toggling Codex-style worktree names renames external worktrees in
  // every project's list. Gated on the change because this refetch
  // costs a git fan-out per worktree, unlike the ones above.
  if (worktreeNamesChanged) {
    void queryClient.invalidateQueries({ queryKey: keys.worktreesAll() });
  }
}

// One Save over two stores, as ONE mutation so isPending, isSuccess and
// error reset atomically per save (two mutations left a failed half's
// error sticky across later successful saves). Each store gets a dirty
// guard on its canonical serialized doc: an unchanged device patch
// skips the CLI spawn entirely (a device write costs a CLI run plus
// launcher re-detection), and an unchanged appearance doc skips
// clientConfig.json.
// Writes run device first, then client, sequentially: a device failure
// persists nothing, and a client failure after a landed device write
// throws SettingsSaveError so the form can advance the persisted half.
export function useSettingsSave({
  initialConfig,
  initialClientConfig,
}: {
  initialConfig: GlobalConfig;
  initialClientConfig: ClientConfig;
}) {
  const queryClient = useQueryClient();
  const initialState = fromConfig(initialConfig, initialClientConfig);
  const initialDevicePatch = serialize(
    toLocalDeviceSettingsPatch(initialState),
  );
  const initialClientDoc = serialize(toClientConfig(initialState));

  return useMutation({
    // Decided up front: initialState follows the live config query, which
    // can refetch the saved value before onSuccess runs.
    onMutate: (state: SettingsFormState) => ({
      worktreeNamesChanged:
        state.codexWorktreeNames !== initialState.codexWorktreeNames,
    }),
    mutationFn: async (
      state: SettingsFormState,
    ): Promise<SettingsSaveResult> => {
      const clientConfig = toClientConfig(state);
      const devicePatch = toLocalDeviceSettingsPatch(state);
      const devicePersisted = serialize(devicePatch) !== initialDevicePatch;
      const clientPersisted = serialize(clientConfig) !== initialClientDoc;
      if (devicePersisted) {
        // The same patch write a peer's save rides, on this machine's
        // own api: the host applies it over the stored document under
        // its config write lock, so everything the form does not manage
        // rides through untouched.
        await window.api.globalConfig.writeDeviceSettings(devicePatch);
      }
      // keepReachable rides the same client store but is written
      // immediately by useKeepReachableUpdate, never staged in this form.
      // The whole-document write clears every modeled key it does not
      // carry, so route the appearance keys through mergeClientConfigWrite:
      // it merges them over the live cached doc, carrying keepReachable
      // (and any other out-of-band key) through so an appearance save
      // cannot wipe it. keepReachable never appears in the dirty diff
      // above, so it cannot trigger a save on its own or get reverted on
      // discard. The returned merged doc is what onSuccess caches.
      let persistedClientConfig: ClientConfig = clientConfig;
      if (clientPersisted) {
        try {
          persistedClientConfig = await mergeClientConfigWrite(
            queryClient,
            clientConfig,
          );
        } catch (error) {
          throw new SettingsSaveError(devicePersisted, error);
        }
      }
      return {
        devicePersisted,
        clientPersisted,
        clientConfig: persistedClientConfig,
      };
    },
    onSuccess: (
      { devicePersisted, clientPersisted, clientConfig },
      _state,
      { worktreeNamesChanged },
    ) => {
      if (clientPersisted) {
        // setQueryData where the device half invalidates: the
        // divergence is deliberate. No CLI merge can change the client
        // store behind our back, so the payload IS the new stored
        // document and a refetch could only tell us what we already
        // know.
        queryClient.setQueryData(queryKeys.clientConfig(), clientConfig);
      }
      if (devicePersisted) {
        invalidateDeviceSettingsQueries(
          queryClient,
          queryKeys,
          worktreeNamesChanged,
        );
      }
    },
    onError: (error, _state, context) => {
      // A SettingsSaveError with devicePersisted means the device write
      // landed before the appearance write failed, so its caches are
      // stale exactly as on success.
      if (error instanceof SettingsSaveError && error.devicePersisted) {
        invalidateDeviceSettingsQueries(
          queryClient,
          queryKeys,
          context?.worktreeNamesChanged ?? true,
        );
      }
    },
    meta: { errorTitle: "Couldn't save settings" },
  });
}
