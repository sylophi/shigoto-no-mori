// The on-disk home of this device's relay credential and its non-secret
// metadata. Pure core: the cipher is injected, so this file imports
// node:fs only and no electron, and the account check script drives both
// the encrypting and the plaintext-fallback paths with a stub cipher.
//
// The credential is the long-lived device secret the enroll response
// returned. It is encrypted at rest by the OS keychain when the platform
// offers one (enc:true), and stored as plaintext with enc:false when it
// does not, so sign-in still works on a machine without a keychain.
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

// The injected encryption seam. `available` records whether the OS could
// actually encrypt: when false the store writes plaintext and stamps
// enc:false so a later read never tries to decrypt it. encrypt/decrypt
// move between the raw credential and the string form written to disk.
export type StoreCipher = {
  available: boolean;
  encrypt(plaintext: string): string;
  decrypt(payload: string): string;
};

// What the caller reads and writes. accountId may be empty (the enroll
// response does not always carry one, see login.ts), deviceName is always
// set.
export type StoredAccount = {
  credential: string;
  accountId: string;
  deviceName: string;
};

// The disk shape. `v` guards a future format change, `enc` records
// whether `credential` is ciphertext. Kept deliberately flat.
type DiskShape = {
  v: 1;
  enc: boolean;
  credential: string;
  accountId: string;
  deviceName: string;
};

export type AccountStore = {
  read(): StoredAccount | null;
  write(account: StoredAccount): void;
  clear(): void;
};

export function createAccountStore(opts: {
  filePath: string;
  cipher: StoreCipher;
}): AccountStore {
  const { filePath, cipher } = opts;

  return {
    read() {
      let raw: string;
      try {
        raw = readFileSync(filePath, "utf8");
      } catch {
        // A missing file is the normal signed-out state. An unreadable
        // file (permissions, partial write) also reads as signed out
        // rather than crashing sign-in.
        return null;
      }
      let parsed: DiskShape;
      try {
        parsed = JSON.parse(raw) as DiskShape;
      } catch {
        // Corrupt JSON reads as signed out. The next write overwrites it.
        return null;
      }
      if (
        !parsed ||
        parsed.v !== 1 ||
        typeof parsed.credential !== "string" ||
        typeof parsed.accountId !== "string" ||
        typeof parsed.deviceName !== "string"
      ) {
        return null;
      }
      try {
        const credential = parsed.enc
          ? cipher.decrypt(parsed.credential)
          : parsed.credential;
        return {
          credential,
          accountId: parsed.accountId,
          deviceName: parsed.deviceName,
        };
      } catch {
        // Decrypt failure (keychain rotated, moved machine) is
        // unrecoverable for this credential. Treat it as signed out so
        // the user can sign in again.
        return null;
      }
    },

    write(account) {
      const disk: DiskShape = {
        v: 1,
        enc: cipher.available,
        credential: cipher.available
          ? cipher.encrypt(account.credential)
          : account.credential,
        accountId: account.accountId,
        deviceName: account.deviceName,
      };
      mkdirSync(dirname(filePath), { recursive: true });
      // Atomic write: a crash mid-write must not leave a half-written
      // file that the next read parses as corrupt and drops. This write
      // stays custom rather than using the shared atomicWriteJsonSync
      // because that helper has no mode option and the mode:0o600 on the
      // credential file is load-bearing.
      const tmp = `${filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(disk), { mode: 0o600 });
      renameSync(tmp, filePath);
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
