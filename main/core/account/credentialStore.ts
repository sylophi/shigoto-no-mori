// The node/desktop adapter for the credential store. It supplies the
// fs-backed storage primitives (an atomic 0o600 write, a tolerant read, a
// swallowed remove) and the OS-keychain cipher, then delegates every
// document-shape and cipher decision to the shared, storage-agnostic core
// in shared/account/credentialStore.ts. The web client reuses that same
// core over a different backing, so the on-storage envelope stays
// identical across platforms and the desktop file format is unchanged.
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  createAccountStore as createCoreStore,
  type AccountStore,
  type StoreCipher,
  type StoredAccount,
} from "@shared/account/credentialStore";

export type { AccountStore, StoreCipher, StoredAccount };

export function createAccountStore(opts: {
  filePath: string;
  cipher: StoreCipher;
}): AccountStore {
  const { filePath, cipher } = opts;

  return createCoreStore({
    cipher,
    storage: {
      readRaw() {
        try {
          return readFileSync(filePath, "utf8");
        } catch {
          // A missing file is the normal signed-out state. An unreadable
          // file (permissions, partial write) also reads as null rather
          // than crashing sign-in.
          return null;
        }
      },
      writeRaw(text) {
        mkdirSync(dirname(filePath), { recursive: true });
        // Atomic write: a crash mid-write must not leave a half-written
        // file that the next read parses as corrupt and drops. This write
        // stays custom rather than using the shared atomicWriteJsonSync
        // because that helper has no mode option and the mode:0o600 on the
        // credential file is load-bearing.
        const tmp = `${filePath}.tmp`;
        writeFileSync(tmp, text, { mode: 0o600 });
        renameSync(tmp, filePath);
      },
      removeRaw() {
        try {
          unlinkSync(filePath);
        } catch {
          // Already gone is success, and no other failure (permissions and
          // so on) is worth failing a sign-out over. Swallow it.
        }
      },
    },
  });
}
