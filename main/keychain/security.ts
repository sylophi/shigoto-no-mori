// Deletes one generic-password item from the default keychain search
// list (the login keychain) through Apple's `security` tool. Electron
// exposes no keychain API beyond safeStorage itself, and deletion is
// the one operation the reset needs (main/keychain/reset.ts).
//
// Synchronous on purpose: it runs at boot before anything can touch
// safeStorage, and takes about ten milliseconds. The timeout bounds
// the one thing that must never stall a launch, a blocking dialog:
// deletion is not ACL-gated, so the only one possible is the unlock
// prompt of a locked login keychain, and safeStorage's own read would
// raise that right after anyway.
//
// Electron-free, so scripts/check-keychain.mjs can run the real thing
// against a probe item.
import { execFileSync } from "node:child_process";

// `security` exits with the OSStatus of the failing call, and
// errSecItemNotFound is -25300, which the shell sees as 44.
const ITEM_NOT_FOUND_EXIT = 44;

const SECURITY_TIMEOUT_MS = 3_000;

export function deleteGenericPassword(
  service: string,
  account: string,
): "deleted" | "missing" {
  try {
    // stdout would echo the deleted item's attributes (never the
    // secret), stderr the failure. Neither is wanted in the log.
    execFileSync(
      "/usr/bin/security",
      ["delete-generic-password", "-s", service, "-a", account],
      { stdio: ["ignore", "ignore", "pipe"], timeout: SECURITY_TIMEOUT_MS },
    );
    return "deleted";
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      error.status === ITEM_NOT_FOUND_EXIT
    ) {
      return "missing";
    }
    throw error;
  }
}
