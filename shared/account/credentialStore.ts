// The storage-agnostic core of this device's hub credential store. It
// owns the on-storage envelope and the pure doc-shape logic (the
// { v:1, enc, credential, accountId, deviceName } document, the enc
// branch, the corrupt-reads-null tolerance) while the raw storage
// primitives are injected, so a node fs backing and a browser
// localStorage backing both plug in without forking this logic. Pure: no
// node builtins, no electron, so the account check drives the core with
// an in-memory backing and the desktop adapter wraps it around fs.
//
// The credential is the long-lived device secret the enroll response
// returned. It is encrypted at rest by the OS keychain when the platform
// offers one (enc:true), and stored as plaintext with enc:false when it
// does not, so sign-in still works on a machine without a keychain.

// The injected encryption seam. `available` records whether the backing
// could actually encrypt: when false the store writes plaintext and
// stamps enc:false so a later read never tries to decrypt it.
// encrypt/decrypt move between the raw credential and the string form
// written to storage.
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

// The stored shape. `v` guards a future format change, `enc` records
// whether `credential` is ciphertext. Kept deliberately flat.
type StoredShape = {
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

// The injected storage primitives. readRaw returns the stored document
// text or null when there is nothing stored or it is unreadable. writeRaw
// persists the document text. removeRaw drops it. The core keeps all
// document-shape and cipher logic and leaves only these three seams to
// the backing.
type AccountStorage = {
  readRaw(): string | null;
  writeRaw(text: string): void;
  removeRaw(): void;
};

export function createAccountStore(opts: {
  storage: AccountStorage;
  cipher: StoreCipher;
}): AccountStore {
  const { storage, cipher } = opts;

  return {
    read() {
      const raw = storage.readRaw();
      // A missing document is the normal signed-out state, and an
      // unreadable one (permissions, partial write) also reads as signed
      // out rather than crashing sign-in.
      if (raw === null) return null;
      let parsed: StoredShape;
      try {
        parsed = JSON.parse(raw) as StoredShape;
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
      const doc: StoredShape = {
        v: 1,
        enc: cipher.available,
        credential: cipher.available
          ? cipher.encrypt(account.credential)
          : account.credential,
        accountId: account.accountId,
        deviceName: account.deviceName,
      };
      storage.writeRaw(JSON.stringify(doc));
    },

    clear() {
      storage.removeRaw();
    },
  };
}
