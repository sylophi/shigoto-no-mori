import {
  type ClientConfig,
  clientSetting,
  DEVICE_SETTINGS_DEFAULTS as DEFAULTS,
  type GlobalConfig,
  type LauncherCommand,
  type TerminalId,
  type Theme,
  type ThemeRotation,
} from "@shigomori/contracts/schemas";
import {
  type DarkTheme,
  type LightTheme,
  resolveDoubutsuPicks,
} from "./themes.ts";

// The settings form's staged state, one flat shape across both stores:
// what this window shows (client config) and what the device stores.
export type SettingsFormState = ClientFormState & DeviceFormState;

interface ClientFormState {
  theme: Theme;
  doubutsu: boolean;
  lightTheme: LightTheme;
  darkTheme: DarkTheme;
  // The interval stays while rotation is off, until the form saves.
  themeRotation: boolean;
  themeRotationEvery: ThemeRotation;
  pauseAnimationsOnBattery: boolean;
  // Whether villager extras show is villageLifeShows' call (the
  // villager data downloaded too), never this field alone.
  villageLife: boolean;
  villageNews: boolean;
  markTerrierProjects: boolean;
  showDeviceBadges: boolean;
  allowAgentWorking: boolean;
  markAgentsWaiting: boolean;
  notifyAgentWaiting: boolean;
  notifyAgentDone: boolean;
  inlineWorktrees: boolean;
  // The keymap's actions bound to keys other than their defaults
  // (lib/keymap.ts), as the client config stores them.
  keybindings: Readonly<Record<string, string>>;
}

interface DeviceFormState {
  launchers: readonly LauncherCommand[];
  hiddenLaunchers: string[];
  launchScripts: boolean;
  terminal: TerminalId;
  // Null opens a file with its default app.
  editor: string | null;
  deleteBranchOnRemove: boolean;
  autoPopulateInstall: boolean;
  autoPullNew: boolean;
  autoPullPrimaryOnly: boolean;
  // Null while the idle shelf is off.
  autoShelveDays: number | null;
  doubutsuNames: boolean;
  codexWorktreeNames: boolean;
  managedOnProjectDrive: boolean;
  portPool: boolean;
  terrier: boolean;
  githubCli: boolean;
}

// Decode, the encoders' other half (useSettingsSave.ts). Each default
// comes from the table its store omits it by, never respelled here.
export function fromConfig(
  config: GlobalConfig,
  clientConfig: ClientConfig,
): SettingsFormState {
  return { ...fromClientConfig(clientConfig), ...fromDeviceConfig(config) };
}

function fromClientConfig(clientConfig: ClientConfig): ClientFormState {
  const picks = resolveDoubutsuPicks(clientConfig);
  return {
    theme: clientSetting(clientConfig, "theme"),
    doubutsu: picks.doubutsu,
    lightTheme: picks.light,
    darkTheme: picks.dark,
    themeRotation: clientConfig.themeRotation !== undefined,
    themeRotationEvery: clientConfig.themeRotation ?? "launch",
    pauseAnimationsOnBattery: clientSetting(
      clientConfig,
      "pauseAnimationsOnBattery",
    ),
    villageLife: clientSetting(clientConfig, "villageLife"),
    villageNews: clientSetting(clientConfig, "villageNews"),
    markTerrierProjects: clientSetting(clientConfig, "markTerrierProjects"),
    showDeviceBadges: clientSetting(clientConfig, "showDeviceBadges"),
    allowAgentWorking: clientSetting(clientConfig, "allowAgentWorking"),
    markAgentsWaiting: clientSetting(clientConfig, "markAgentsWaiting"),
    notifyAgentWaiting: clientSetting(clientConfig, "notifyAgentWaiting"),
    notifyAgentDone: clientSetting(clientConfig, "notifyAgentDone"),
    inlineWorktrees: clientSetting(clientConfig, "inlineWorktrees"),
    keybindings: clientConfig.keybindings ?? {},
  };
}

function fromDeviceConfig(config: GlobalConfig): DeviceFormState {
  return {
    launchers: config.launchers ?? [],
    // Sorted here and on every toggle so the id list has one canonical
    // order. useDirtyForm compares FormState by JSON.stringify, and
    // hiding is set-semantic -- without this, re-hiding a tool in a
    // different order would read as an unsaved change.
    hiddenLaunchers: (config.hiddenLaunchers ?? []).toSorted(),
    launchScripts: config.launchScripts ?? DEFAULTS.launchScripts,
    terminal: config.terminal ?? DEFAULTS.terminal,
    editor: config.editor ?? DEFAULTS.editor,
    deleteBranchOnRemove:
      config.deleteBranchOnRemove ?? DEFAULTS.deleteBranchOnRemove,
    autoPopulateInstall:
      config.autoPopulateInstall ?? DEFAULTS.autoPopulateInstall,
    autoPullNew: config.autoPullNew ?? DEFAULTS.autoPullNew,
    autoPullPrimaryOnly:
      config.autoPullPrimaryOnly ?? DEFAULTS.autoPullPrimaryOnly,
    autoShelveDays: config.autoShelveDays ?? DEFAULTS.autoShelveDays,
    doubutsuNames: config.doubutsuNames ?? DEFAULTS.doubutsuNames,
    codexWorktreeNames:
      config.codexWorktreeNames ?? DEFAULTS.codexWorktreeNames,
    managedOnProjectDrive:
      config.managedOnProjectDrive ?? DEFAULTS.managedOnProjectDrive,
    portPool: config.portPool ?? DEFAULTS.portPool,
    terrier: config.terrier ?? DEFAULTS.terrier,
    githubCli: config.githubCli ?? DEFAULTS.githubCli,
  };
}

const CLIENT_FIELDS = Object.keys(
  fromClientConfig({}),
) as (keyof ClientFormState)[];

// `form` with its client-config fields as `client` has them: the
// snapshot after a save whose device write landed and client write
// didn't.
export function withClientFields(
  form: SettingsFormState,
  client: SettingsFormState,
): SettingsFormState {
  const merged = { ...form };
  for (const key of CLIENT_FIELDS)
    Object.assign(merged, { [key]: client[key] });
  return merged;
}

// A draft over a seed that moved: what the form changed stays, the rest
// takes the new seed.
export function keepTouched(
  form: SettingsFormState,
  saved: SettingsFormState,
  next: SettingsFormState,
): SettingsFormState {
  const merged = { ...next };
  for (const key of Object.keys(form) as (keyof SettingsFormState)[]) {
    if (JSON.stringify(form[key]) !== JSON.stringify(saved[key])) {
      Object.assign(merged, { [key]: form[key] });
    }
  }
  return merged;
}
