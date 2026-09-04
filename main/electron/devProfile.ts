// The dev profile this instance runs as (shared/appName.mts), for the
// two consumers: main/index.ts (userData and app name) and the account
// module (the default device name). Derived lazily from the
// environment, which is there from process start, so no reader
// depends on boot order. initDevProfile is the boot-time validation
// that turns a bad value into an error box instead of a silent plain
// dev instance.
import { app } from "electron";
import {
  DEV_PROFILE_ENV,
  devProfileFromEnv,
  devProfileNameSuffix,
} from "@shared/appName.mts";

let profile: string | null | undefined;

function current(): string | null {
  if (profile === undefined) {
    try {
      profile = app.isPackaged ? null : devProfileFromEnv(process.env);
    } catch {
      // Malformed: initDevProfile reports it, readers see no profile.
      profile = null;
    }
  }
  return profile;
}

// Null for a packaged build and for the plain dev instance. Throws on
// a malformed name, and on a profile without SHIGOMORI_ROOT: that
// would enroll a second device over the same forest, so it is refused
// at boot rather than discovered on the Devices page. A refused
// profile leaves the readers seeing no profile at all.
export function initDevProfile(): string | null {
  if (app.isPackaged) return null;
  profile = null;
  const name = devProfileFromEnv(process.env);
  if (name !== null && !process.env.SHIGOMORI_ROOT) {
    throw new Error(
      `${DEV_PROFILE_ENV} needs SHIGOMORI_ROOT set to the profile's own ` +
        "state root. Use `pnpm start --profile <name>` or " +
        "`pnpm dev:peer <name>`, which set both.",
    );
  }
  profile = name;
  return name;
}

// What this instance appends to names, "" when it is no profile.
export function devProfileSuffix(): string {
  const name = current();
  return name === null ? "" : devProfileNameSuffix(name);
}
