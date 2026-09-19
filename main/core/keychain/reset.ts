// The one-time reset of the app's macOS Safe Storage keychain item, the
// pure decision around it. The Electron wiring (app name, userData,
// the marker file) is main/electron/keychain.ts, and the real deletion
// lives in ./security.ts, so this file can be driven under plain node
// (test/keychain.mjs).
//
// Why a reset exists at all. Electron's safeStorage keeps its
// encryption key in the login keychain as one generic-password item,
// "<app name> Safe Storage" / "<app name> Key". macOS protects that
// item with an access control list naming the app that CREATED it,
// by code-signing requirement: for a Developer ID build that is the
// designated requirement (bundle id plus team), which every later
// signed build satisfies, so reads never prompt. For an ad-hoc
// signature (the dev Electron binary, a local `pnpm package`) it is
// that one binary's code hash, and every other binary reading the
// item gets the "wants to use your confidential information in your
// keychain" dialog, with the login password, once per read: "Allow"
// grants one read, and a signed build reads the key twice at boot
// (the sync safeStorage path and the async one the Clerk token store
// prefers), each read two dialogs on current macOS. That is the four
// prompts a signed 2.0 beta produced on a machine where an earlier
// dev run had created the item.
//
// The cure is for the signed app to create the item itself, which
// means deleting the one it found. Deletion needs no ACL grant (it
// decrypts nothing), so it never prompts. The cost is that whatever
// was encrypted under the old key (the hub device credential, the
// Clerk tokens) can no longer be read: both stores treat an
// undecryptable value as absent, so the user is signed out once and
// signs in again. That happens once per userData: the marker written
// after the deletion says a signed build owns the item, and a reset
// that throws (keychain locked, `security` missing) leaves no marker,
// so the next launch retries.
//
// Only Developer-ID-signed packaged builds run this (main/index.ts):
// every other flavor uses Chromium's mock keychain and never touches
// the item, so an unsigned build cannot reset the signed install's
// key out from under it.

// The marker in userData, beside the token store the key unlocks. Its
// presence is the whole message. It has no content.
export const SAFE_STORAGE_OWNED_MARKER = "safe-storage.owned";

// Electron's naming of the item, derived from app.name. Matches what a
// packaged build actually creates (verified against a login keychain
// dump). A drift here would delete nothing and cure nothing.
export function safeStorageItemNames(appName: string): {
  service: string;
  account: string;
} {
  return { service: `${appName} Safe Storage`, account: `${appName} Key` };
}

export type ResetIo = {
  hasMarker(): boolean;
  writeMarker(): void;
  // Removes one matching item. "missing" when there is none left. Any
  // other failure throws, and the throw propagates: the marker is only
  // ever written once a deletion has reported the item missing.
  deleteItem(): "deleted" | "missing";
};

// `security` deletes the first match in the keychain search list, and
// a stray second keychain on that list could hold another copy that
// safeStorage would go on finding. Deletion repeats until nothing
// matches, bounded so a deleter that never says "missing" cannot
// spin the launch.
const MAX_DELETIONS = 8;

// "owned": the marker is there, nothing was touched. "deleted": at
// least one item went. "missing": there was none. The marker is
// written for both of the latter.
export type ResetOutcome = "owned" | "deleted" | "missing";

export function resetSafeStorageOnce(io: ResetIo): ResetOutcome {
  if (io.hasMarker()) return "owned";
  let deleted = 0;
  while (io.deleteItem() === "deleted") {
    deleted += 1;
    if (deleted >= MAX_DELETIONS) break;
  }
  io.writeMarker();
  return deleted > 0 ? "deleted" : "missing";
}
