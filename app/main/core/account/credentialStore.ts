// The node/desktop adapter for the credential store. It supplies the
// fs-backed storage primitives (an atomic 0o600 write, a tolerant read, a
// swallowed remove) and the OS-keychain cipher, then delegates every
// document-shape and cipher decision to the shared, storage-agnostic core
// in shared/account/credentialStore.ts. The web client reuses that same
// core over a different backing, so the on-storage envelope stays
// identical across platforms and the desktop file format is unchanged.
import { errorMessageOf } from "@shared/errors";
import { isENOENT } from "@host/lib/util/paths";
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
  const tmpPath = `${filePath}.tmp`;

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
        // file that the next read parses as corrupt and drops. Custom
        // rather than the shared JSON helper because the text is
        // already an envelope, and mode 0o600 is load-bearing.
        writeFileSync(tmpPath, text, { mode: 0o600 });
        renameSync(tmpPath, filePath);
      },
      removeRaw() {
        // The temp file too: a crash between its write and the rename
        // leaves the envelope there.
        for (const path of [filePath, tmpPath]) {
          try {
            unlinkSync(path);
          } catch (error) {
            // Already gone is success. No other failure is worth
            // failing a sign-out over, but a credential that stayed is
            // worth a line.
            if (!isENOENT(error)) {
              console.warn(
                `[account] could not remove ${path}: ${errorMessageOf(error)}`,
              );
            }
          }
        }
      },
    },
  });
}
