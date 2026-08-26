// The on-disk home of this host's command-execution grants (v2 step 4,
// slice D). A grant is a list of peer deviceIds this machine trusts to
// run MUTATING calls on it over the account relay, scoped to the CURRENT
// account so signing into a different account never inherits the old
// account's grants. Pure core: the file path is injected, so this file
// stays electron-free (node:fs plus the shared electron-free atomic-write
// helper), and the account check drives it headlessly.
//
// Unlike the credential store, a grant list is NOT a bearer secret: it
// is a plain list of deviceIds this host chose to trust, so plaintext in
// userData with mode 0o600 is enough and no keychain cipher is needed. A
// tampered file only ever changes which peers this host permits, and the
// user controls that list from the account settings anyway.
import { readFileSync, unlinkSync } from "node:fs";
import { atomicWriteJsonSync } from "@host/lib/util/jsonFile";

// A ceiling on the stored grant list so a runaway local write cannot grow
// grants.json without bound. It matches the presence-roster cap
// (MAX_ONLINE_DEVICES) because a host granting more than this many of its
// OWN devices is not a real scenario, so refusing past it is safe.
const MAX_GRANTED_PEERS = 1024;

// What the caller reads back: the account these grants belong to and the
// peer deviceIds granted command access under it. accountId matches the
// signed-in account's id (see login.ts's deriveAccountId), possibly the
// empty string when the enroll response carried no account.
export type StoredGrants = {
  accountId: string;
  grantedPeers: string[];
};

// The disk shape. `v` guards a future format change. Kept deliberately
// flat and mirrors credentialStore's DiskShape discipline.
type DiskShape = {
  v: 1;
  accountId: string;
  grantedPeers: string[];
};

export type GrantStore = {
  // The raw stored record, or null when the file is missing or corrupt.
  read(): StoredGrants | null;
  // The granted peer deviceIds for `accountId`. A stored account that
  // does not match (a different account, or a missing/corrupt file)
  // yields no grants, so grants never leak across accounts.
  list(accountId: string): string[];
  // Trust `deviceId` to run commands under `accountId`. Calling with an
  // accountId that differs from the stored one RESETS the record to the
  // new account first, so grants do not carry across accounts.
  grant(accountId: string, deviceId: string): void;
  // Withdraw `deviceId`'s command access under `accountId`. As with
  // grant, a differing accountId resets to the new account (leaving it
  // with no grants), so the operation is always scoped to one account.
  revoke(accountId: string, deviceId: string): void;
  // Remove the file entirely, e.g. on sign-out.
  clear(): void;
};

export function createGrantStore(opts: { filePath: string }): GrantStore {
  const { filePath } = opts;

  function read(): StoredGrants | null {
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch {
      // A missing file is the normal no-grants state. An unreadable file
      // (permissions, partial write) also reads as no grants rather than
      // crashing a dispatch that consults the store.
      return null;
    }
    let parsed: DiskShape;
    try {
      parsed = JSON.parse(raw) as DiskShape;
    } catch {
      // Corrupt JSON reads as no grants. The next grant/revoke overwrites
      // it.
      return null;
    }
    if (
      !parsed ||
      parsed.v !== 1 ||
      typeof parsed.accountId !== "string" ||
      !Array.isArray(parsed.grantedPeers) ||
      parsed.grantedPeers.some((peer) => typeof peer !== "string")
    ) {
      return null;
    }
    return {
      accountId: parsed.accountId,
      grantedPeers: [...parsed.grantedPeers],
    };
  }

  function write(record: StoredGrants): void {
    const disk: DiskShape = {
      v: 1,
      accountId: record.accountId,
      grantedPeers: record.grantedPeers,
    };
    // Atomic write via the shared helper: a crash mid-write must not leave
    // a half-written file that the next read parses as corrupt and drops.
    // The helper handles the tempPathFor collision guard and the
    // rename-failure cleanup; mode:0o600 matches the credential file so
    // the grant list is not world-readable in a shared userData directory.
    atomicWriteJsonSync(filePath, disk, { mode: 0o600 });
  }

  // The record to mutate for `accountId`: the stored one when the
  // account matches, else a fresh empty record for the new account. This
  // is the single place the "grants do not carry across accounts" rule
  // is enforced on write.
  function recordFor(accountId: string): StoredGrants {
    const current = read();
    if (current !== null && current.accountId === accountId) return current;
    return { accountId, grantedPeers: [] };
  }

  return {
    read,

    list(accountId) {
      const current = read();
      if (current === null || current.accountId !== accountId) return [];
      return [...current.grantedPeers];
    },

    grant(accountId, deviceId) {
      const record = recordFor(accountId);
      // Idempotent: granting an already-trusted peer is a no-op, never a
      // duplicate entry. recordFor only ever returns a record already
      // containing deviceId when the account matched (a differing account
      // resets to an empty record first), so the stored file already holds
      // this grant and there is nothing to write.
      if (record.grantedPeers.includes(deviceId)) return;
      // Refuse past the ceiling rather than growing the file without
      // bound. This is unreachable in any real use (a host does not own
      // 1024 devices), so a thrown error is the simplest safe behavior.
      if (record.grantedPeers.length >= MAX_GRANTED_PEERS) {
        throw new Error(
          `cannot grant more than ${MAX_GRANTED_PEERS} command peers`,
        );
      }
      record.grantedPeers = [...record.grantedPeers, deviceId];
      write(record);
    },

    revoke(accountId, deviceId) {
      const record = recordFor(accountId);
      record.grantedPeers = record.grantedPeers.filter(
        (peer) => peer !== deviceId,
      );
      write(record);
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
