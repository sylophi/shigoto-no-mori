import {
  type QueryClient,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  ClientConfig,
  GlobalConfig,
  LauncherCommand,
  Theme,
} from "@shared/schemas";
import { errorMessageOf } from "@shared/errors";
import { queryKeys } from "@/lib/queryKeys";

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

// Decode lives beside the two encoders so encode, decode and the dirty
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

function toConfig(
  original: GlobalConfig,
  state: SettingsFormState,
): GlobalConfig {
  const valid = state.launchers.filter(
    (l) => l.label.trim().length > 0 && l.command.trim().length > 0,
  );
  return {
    ...original,
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

// Appearance saves through the client-scoped store, not the device
// config. Same omit-on-default serialization as toConfig.
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
  const initialDeviceDoc = serialize(toConfig(initialConfig, initialState));
  const initialClientDoc = serialize(toClientConfig(initialState));

  return useMutation({
    mutationFn: async (
      state: SettingsFormState,
    ): Promise<SettingsSaveResult> => {
      const deviceConfig = toConfig(initialConfig, state);
      const clientConfig = toClientConfig(state);
      const devicePersisted = serialize(deviceConfig) !== initialDeviceDoc;
      const clientPersisted = serialize(clientConfig) !== initialClientDoc;
      if (devicePersisted) {
        await window.api.globalConfig.write(deviceConfig);
      }
      if (clientPersisted) {
        try {
          await window.api.clientConfig.write(clientConfig);
        } catch (error) {
          throw new SettingsSaveError(devicePersisted, error);
        }
      }
      return { devicePersisted, clientPersisted, clientConfig };
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
