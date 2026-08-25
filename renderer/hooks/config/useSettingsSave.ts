import {
  type QueryClient,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  ClientConfig,
  DeviceSettingsPatch,
  GlobalConfig,
  LauncherCommand,
  Theme,
} from "@shared/schemas";
import { errorMessageOf } from "@shared/errors";
import { updateLocalGlobalConfig } from "@/lib/config/localGlobalConfig";
import { queryKeys } from "@/lib/queryKeys";
import { mergeClientConfigWrite } from "./mergeClientConfigWrite";

// The settings form's staged state. One flat shape across both stores:
// the first two fields are client config (appearance), the rest are
// device config.
export interface SettingsFormState {
  theme: Theme;
  doubutsu: boolean;
  launchers: LauncherCommand[];
  hiddenLaunchers: string[];
  launchScripts: boolean;
  deleteBranchOnRemove: boolean;
  autoPopulateInstall: boolean;
  portPool: boolean;
  githubCli: boolean;
}

// Decode lives beside the encoders so encode, decode and the dirty
// diff below share one file: the diff compares docs produced by these
// functions, never respelled default literals.
export function fromConfig(
  config: GlobalConfig,
  clientConfig: ClientConfig,
): SettingsFormState {
  return {
    theme: clientConfig.theme ?? "system",
    doubutsu: clientConfig.doubutsu ?? true,
    launchers: config.launchers ?? [],
    // Sorted here and on every toggle so the id list has one canonical
    // order. useDirtyForm compares FormState by JSON.stringify, and
    // hiding is set-semantic -- without this, re-hiding a tool in a
    // different order would read as an unsaved change.
    hiddenLaunchers: (config.hiddenLaunchers ?? []).toSorted(),
    launchScripts: config.launchScripts ?? true,
    deleteBranchOnRemove: config.deleteBranchOnRemove ?? true,
    autoPopulateInstall: config.autoPopulateInstall ?? false,
    portPool: config.portPool ?? false,
    githubCli: config.githubCli ?? true,
  };
}

// The managed device keys only, without a base document under them. Two
// jobs: it is the dirty projection (an unchanged managed set skips the
// CLI spawn), and it is what gets spread over the unredacted base at
// save time to form the write. Keeping it base free is what lets the
// dirty check ignore socketHost and remoteDevices, which the form never
// manages and which the redacted read it was built from does not carry.
function managedDeviceConfig(state: SettingsFormState): GlobalConfig {
  const valid = validLaunchers(state);
  return {
    launchers: valid.length > 0 ? valid : undefined,
    // Default is everything shown; omit the key entirely when nothing is
    // hidden rather than persisting an empty array.
    hiddenLaunchers:
      state.hiddenLaunchers.length > 0 ? state.hiddenLaunchers : undefined,
    // Default is on; same opt-out serialization as deleteBranchOnRemove.
    launchScripts: state.launchScripts ? undefined : false,
    // Default is true; omit when on, store explicit `false` when off so
    // the user's opt-out survives reads.
    deleteBranchOnRemove: state.deleteBranchOnRemove ? undefined : false,
    // Default is false; only persist when explicitly enabled.
    autoPopulateInstall: state.autoPopulateInstall ? true : undefined,
    portPool: state.portPool ? true : undefined,
    // Default is true; same opt-out serialization as deleteBranchOnRemove.
    githubCli: state.githubCli ? undefined : false,
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

// The remote encoding of the same seven managed keys (v2 step 6): the
// globalConfig.writeDeviceSettings patch. EXPLICIT values throughout,
// where managedDeviceConfig omits a key at its default: the host
// applies the patch as absent-means-keep (an undefined key cannot
// survive the wire), so the omit-on-default encoding would silently
// fail to revert a remote key back to its default. No default literal
// is respelled here — the form state already carries every key's
// concrete value.
export function toDeviceSettingsPatch(
  state: SettingsFormState,
): DeviceSettingsPatch {
  return {
    launchers: validLaunchers(state),
    hiddenLaunchers: state.hiddenLaunchers,
    launchScripts: state.launchScripts,
    deleteBranchOnRemove: state.deleteBranchOnRemove,
    autoPopulateInstall: state.autoPopulateInstall,
    portPool: state.portPool,
    githubCli: state.githubCli,
  };
}

// The full write document: the managed keys spread over an unredacted
// base. The CLI write is whole document for its registered keys (an
// omitted registered key is deleted, socketHost.token included), so the
// base MUST be the unredacted local doc rather than the redacted read
// the form was built from. Spread order matters: the managed keys carry
// their own undefined defaults, which override the base so the omit on
// default serialization still holds. Everything the form does not
// manage (socketHost with its token, remoteDevices, any unknown key)
// rides through from the base untouched.
function toWriteDoc(
  base: GlobalConfig,
  state: SettingsFormState,
): GlobalConfig {
  return { ...base, ...managedDeviceConfig(state) };
}

// Appearance saves through the client-scoped store, not the device
// config. Same omit-on-default serialization as managedDeviceConfig.
function toClientConfig(state: SettingsFormState): ClientConfig {
  return {
    // Default is "system"; omit when on the default to keep the file tidy.
    theme: state.theme === "system" ? undefined : state.theme,
    // Default is on; omit when on, store explicit `false` when off so
    // the user's opt-out survives reads (same as deleteBranchOnRemove).
    doubutsu: state.doubutsu ? undefined : false,
  };
}

// The docs are canonical by construction (one encoder, undefined keys
// dropped by JSON.stringify), so equal serializations mean an
// unchanged store.
function serialize(doc: GlobalConfig | ClientConfig): string {
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

// LOCAL keys on purpose, paired with the write path: the save below
// goes through updateLocalGlobalConfig, whose readLocal/write are
// local-only by design, so the caches it staled are exactly the local
// device's. Must not move to a useHostScope registry while the write
// stays local (see the exception list in hooks/remote/useHostScope).
function invalidateDeviceQueries(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.globalConfig() });
  // Launcher catalogs for every project depend on global custom launchers.
  void queryClient.invalidateQueries({ queryKey: queryKeys.launchersAll() });
  // Toggling the GitHub CLI integration flips both readiness gating
  // and the project PR list -- refetch immediately rather than wait
  // for the next focus/mount.
  void queryClient.invalidateQueries({ queryKey: queryKeys.githubCliAll() });
}

// One Save over two stores, as ONE mutation so isPending, isSuccess and
// error reset atomically per save (two mutations left a failed half's
// error sticky across later successful saves). Each store gets a dirty
// guard on its canonical serialized doc: an unchanged device doc skips
// the CLI spawn entirely (a device write costs a CLI run plus launcher
// re-detection), and an unchanged appearance doc skips clientConfig.json.
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
  // Dirty against the managed projection, not a base-spread doc: the base
  // is read fresh at save time and carries keys the form never touches.
  const initialManagedDoc = serialize(managedDeviceConfig(initialState));
  const initialClientDoc = serialize(toClientConfig(initialState));

  return useMutation({
    mutationFn: async (
      state: SettingsFormState,
    ): Promise<SettingsSaveResult> => {
      const clientConfig = toClientConfig(state);
      const devicePersisted =
        serialize(managedDeviceConfig(state)) !== initialManagedDoc;
      const clientPersisted = serialize(clientConfig) !== initialClientDoc;
      if (devicePersisted) {
        // Route through the single serialized writer so this save cannot
        // race a hosting or remote-device write and clobber its domain.
        // updateLocalGlobalConfig owns the read-unredacted-base-then-write
        // -full-doc invariant: it reads the base imperatively (so the
        // token never lands in a cached query) and the whole-document CLI
        // write keeps socketHost.token and remoteDevices, which the
        // redacted read the form was built from omits.
        await updateLocalGlobalConfig((base) => toWriteDoc(base, state));
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
    onSuccess: ({ devicePersisted, clientPersisted, clientConfig }) => {
      if (clientPersisted) {
        // setQueryData where the device half invalidates: the
        // divergence is deliberate. No CLI merge can change the client
        // store behind our back, so the payload IS the new stored
        // document and a refetch could only tell us what we already
        // know.
        queryClient.setQueryData(queryKeys.clientConfig(), clientConfig);
      }
      if (devicePersisted) {
        invalidateDeviceQueries(queryClient);
      }
    },
    onError: (error) => {
      // A SettingsSaveError with devicePersisted means the device write
      // landed before the appearance write failed, so its caches are
      // stale exactly as on success.
      if (error instanceof SettingsSaveError && error.devicePersisted) {
        invalidateDeviceQueries(queryClient);
      }
    },
    meta: { errorTitle: "Couldn't save settings" },
  });
}
