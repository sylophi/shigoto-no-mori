// The dev profile this instance runs as (shared/packaging/appName.mts),
// for the two consumers: main/index.ts (userData and app name) and the
// account (the default device name). Set by initDevProfile, at boot,
// which turns a bad value into an error box instead of a silent plain
// dev instance.
import { app } from "electron";
import {
  DEV_PROFILE_ENV,
  devProfileNameSuffix,
  profileFromEnv,
} from "@shared/packaging/appName.mts";
import { envSetting } from "@shared/config";

let profile: string | null = null;

// Null for a release build and for the plain dev instance. Throws on
// a malformed name, and on a profile without SHIGOMORI_DATA_DIR: that
// would enroll a second device over the same forest, so it is refused
// at boot rather than discovered on the account page. A refused
// profile leaves the readers seeing no profile at all.
export function initDevProfile(): string | null {
  const name = profileFromEnv(app.isPackaged, {
    [DEV_PROFILE_ENV]: envSetting(DEV_PROFILE_ENV),
  });
  if (name !== null && envSetting("SHIGOMORI_DATA_DIR") === undefined) {
    throw new Error(
      `${DEV_PROFILE_ENV} needs SHIGOMORI_DATA_DIR set to the profile's own ` +
        "data dir. Use `pnpm start --profile <name>` or " +
        "`pnpm device <name>`, which set both.",
    );
  }
  profile = name;
  return name;
}

// What this instance appends to names, "" when it is no profile.
export function devProfileSuffix(): string {
  return profile === null ? "" : devProfileNameSuffix(profile);
}
