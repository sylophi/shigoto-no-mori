// The on-disk home of this host's command-access grant. One switch: whether this machine serves MUTATING calls
// from the account's OTHER devices over the direct data plane, scoped
// to the CURRENT account so signing into a different account never
// inherits the old account's answer. The account is the trust
// boundary (every device on it is the same person's), so the decision
// is "may my other machines drive this one", made HERE on the machine
// being driven, not a list of which peers may. Pure core: the file
// path is injected, so this file stays electron-free (node:fs plus the
// shared electron-free atomic-write helper), and the account check
// drives it headlessly.
//
// Unlike the credential store, the grant is NOT a bearer secret: it is
// one boolean this host chose, so plaintext in userData with mode
// 0o600 is enough and no keychain cipher is needed. A tampered file
// only ever flips whether this host accepts its own account's
// commands, which the user controls from the Devices page anyway.
import { readFileSync, unlinkSync } from "node:fs";
import { atomicWriteJsonSync } from "@host/lib/util/jsonFile";

// What the caller reads back: the account the grant belongs to and
// whether command access is on under it. accountId matches the
// signed-in account's id (see token.ts's deriveAccountId), possibly
// the empty string when the enroll response carried no account.
export type StoredGrant = {
  accountId: string;
  enabled: boolean;
};

// The disk shape. `v` guards the format. Kept deliberately flat and
// mirrors credentialStore's DiskShape discipline.
type DiskShape = {
  v: 2;
  accountId: string;
  enabled: boolean;
};

// The format before the switch: the peer deviceIds this host trusted.
// It is read once more so an update does not lock out a machine that
// is driven remotely. A host that trusted any of its account's devices
// keeps accepting the account's commands (every listed peer was one of
// them), and a host that trusted none stays closed. The next set()
// writes v2.
type LegacyDiskShape = {
  v: 1;
  accountId: string;
  grantedPeers: string[];
};

export type GrantStore = {
  // The raw stored record, or null when the file is missing or corrupt.
  read(): StoredGrant | null;
  // Whether command access is on for `accountId`. A stored account
  // that does not match (a different account, or a missing/corrupt
  // file) reads as off, so a grant never leaks across accounts.
  enabled(accountId: string): boolean;
  // Switch command access on or off under `accountId`. Calling with an
  // accountId that differs from the stored one RESETS the record to the
  // new account, so the answer never carries across accounts.
  set(accountId: string, enabled: boolean): void;
  // Remove the file entirely, e.g. on sign-out.
  clear(): void;
};

export function createGrantStore(opts: { filePath: string }): GrantStore {
  const { filePath } = opts;

  function read(): StoredGrant | null {
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch {
      // A missing file is the normal off state. An unreadable file
      // (permissions, partial write) also reads as off rather than
      // crashing a dispatch that consults the store.
      return null;
    }
    let parsed: DiskShape | LegacyDiskShape;
    try {
      parsed = JSON.parse(raw) as DiskShape | LegacyDiskShape;
    } catch {
      // Corrupt JSON reads as off. The next set overwrites it.
      return null;
    }
    if (!parsed || typeof parsed.accountId !== "string") return null;
    if (parsed.v === 1) {
      if (
        !Array.isArray(parsed.grantedPeers) ||
        parsed.grantedPeers.some((peer) => typeof peer !== "string")
      ) {
        return null;
      }
      return {
        accountId: parsed.accountId,
        enabled: parsed.grantedPeers.length > 0,
      };
    }
    if (parsed.v !== 2 || typeof parsed.enabled !== "boolean") return null;
    return { accountId: parsed.accountId, enabled: parsed.enabled };
  }

  return {
    read,

    enabled(accountId) {
      const current = read();
      return current !== null && current.accountId === accountId
        ? current.enabled
        : false;
    },

    set(accountId, enabled) {
      const disk: DiskShape = { v: 2, accountId, enabled };
      // Atomic write via the shared helper: a crash mid-write must not
      // leave a half-written file that the next read parses as corrupt
      // and drops. The helper handles the tempPathFor collision guard
      // and the rename-failure cleanup; mode:0o600 matches the
      // credential file so the grant is not world-readable in a shared
      // userData directory. selfWrite:false because this file lives in
      // userData, outside the watched shigomori root: claiming a
      // self-write here would blind the state watcher to a genuine
      // external write for the echo window.
      atomicWriteJsonSync(filePath, disk, { mode: 0o600, selfWrite: false });
    },

    clear() {
      try {
        unlinkSync(filePath);
      } catch {
        // Already gone is success, and no other failure (permissions and
        // so on) is worth failing a sign-out over. Swallow it.
      }
    },
  };
}
