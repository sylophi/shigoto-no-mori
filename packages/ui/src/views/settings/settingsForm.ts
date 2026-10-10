import type {
  LauncherCommand,
  TerminalId,
  Theme,
} from "@shigomori/contracts/schemas";
import type { DarkTheme, LightTheme } from "../../lib/themes.ts";

// The settings form's staged state. One flat shape across both stores:
// the first thirteen fields are client config (appearance), the rest
// are device config.
export interface SettingsFormState {
  theme: Theme;
  doubutsu: boolean;
  lightTheme: LightTheme;
  darkTheme: DarkTheme;
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
  launchers: readonly LauncherCommand[];
  hiddenLaunchers: string[];
  launchScripts: boolean;
  terminal: TerminalId;
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
