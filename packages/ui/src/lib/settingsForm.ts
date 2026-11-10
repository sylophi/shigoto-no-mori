import {
  type ClientConfig,
  clientSetting,
  DEVICE_SETTINGS_DEFAULTS as DEFAULTS,
  type DeviceSettingsPatch,
  type GlobalConfig,
  type Theme,
  type ThemeRotation,
} from "@shigomori/contracts/schemas";
import {
  type DarkTheme,
  type LightTheme,
  resolveDoubutsuPicks,
} from "./themes.ts";

// The settings forms' staged state, one form per store: what this
// window shows (client config) and what a device stores.
export interface ClientFormState {
  theme: Theme;
  doubutsu: boolean;
  lightTheme: LightTheme;
  darkTheme: DarkTheme;
  // The interval stays while rotation is off, until the form saves.
  themeRotation: boolean;
  themeRotationEvery: ThemeRotation;
  pauseAnimationsOnBattery: boolean;
  darkTerminals: boolean;
  widenForSideTerminals: boolean;
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

export type DeviceFormState = Required<DeviceSettingsPatch>;

const DEVICE_FIELDS = Object.keys(DEFAULTS) as (keyof DeviceFormState)[];

// Decode, the encoders' other half (useSettingsSave.ts,
// useDeviceSettingsSave.ts). Each default comes from the table its
// store omits it by, never respelled here.
export function fromClientConfig(clientConfig: ClientConfig): ClientFormState {
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
    darkTerminals: clientSetting(clientConfig, "darkTerminals"),
    widenForSideTerminals: clientSetting(clientConfig, "widenForSideTerminals"),
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

export function fromDeviceConfig(config: GlobalConfig): DeviceFormState {
  const form = Object.fromEntries(
    DEVICE_FIELDS.map((key) => [key, config[key] ?? DEFAULTS[key]]),
  ) as DeviceFormState;
  // Sorted here and on every toggle so the id list has one canonical
  // order. useDirtyForm compares FormState by JSON.stringify, and
  // hiding is set-semantic -- without this, re-hiding a tool in a
  // different order would read as an unsaved change.
  return { ...form, hiddenLaunchers: form.hiddenLaunchers.toSorted() };
}
