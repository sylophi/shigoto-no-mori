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

import { isDeviceIcon, type DeviceIcon } from "./deviceIcon";

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

// What the caller reads and writes. accountId may be empty (a token
// that does not parse yields "", see token.ts), deviceName is always
// set. deviceIcon is the owner's pick of what this device looks like
// (shared/account/deviceIcon.ts), present only once they picked one:
// absent, the device reports what it detected about itself.
export type StoredAccount = {
  credential: string;
  accountId: string;
  deviceName: string;
  deviceIcon?: DeviceIcon;
};

// The stored shape. `v` guards a future format change, `enc` records
// whether `credential` is ciphertext. Kept deliberately flat.
type StoredShape = {
  v: 1;
  enc: boolean;
  credential: string;
  accountId: string;
  deviceName: string;
  deviceIcon?: DeviceIcon;
};

// What a sign-out leaves behind, in the same slot: the device's name
// and picked icon (so the next enrollment keeps them instead of
// reverting to the machine defaults) and, when the sign-out's revoke
// never reached the hub, the credential it should have revoked with,
// parked for a later retry (enroll.ts retryParkedRevoke). A parked
// credential is a dead one as far as this device is concerned: read()
// never returns it.
type SignedOutShape = {
  v: 1;
  signedOut: true;
  deviceName: string;
  deviceIcon?: DeviceIcon;
  parked?: { enc: boolean; credential: string; accountId: string };
};

export type AccountStore = {
  read(): StoredAccount | null;
  // read() !== null, for callers that only need the verdict.
  signedIn(): boolean;
  write(account: StoredAccount): void;
  // Signs out: drops the credential, keeps the name (and any parked
  // revoke).
  clear(): void;
  // The name the device last enrolled under, kept across a sign-out.
  rememberedDeviceName(): string | null;
  // The icon its owner last picked, kept across a sign-out the same way.
  rememberedDeviceIcon(): DeviceIcon | null;
  // Parks a credential whose revoke did not land, signing out.
  park(account: StoredAccount): void;
  readParked(): StoredAccount | null;
  clearParked(): void;
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

// The picked icon on a document of either shape, or undefined when
// none was picked (or the field holds something this build does not
// know, which reads as unpicked rather than crashing the store). A
// document written before the field was renamed holds the pick under
// deviceKind, read here so an upgrade keeps it. Every write rebuilds
// the document, so the next one stores it as deviceIcon.
function iconOf(
  doc: (StoredShape | SignedOutShape) & { deviceKind?: unknown },
): DeviceIcon | undefined {
  const picked = doc.deviceIcon ?? doc.deviceKind;
  return isDeviceIcon(picked) ? picked : undefined;
}

// The opened credential plus the identity the document keeps beside
// it: the name always, the icon only when one was picked.
function withIdentity(
  doc: StoredShape | SignedOutShape,
  opened: { credential: string; accountId: string },
): StoredAccount {
  const icon = iconOf(doc);
  return {
    ...opened,
    deviceName: doc.deviceName,
    ...(icon === undefined ? {} : { deviceIcon: icon }),
  };
}

export function createAccountStore(opts: {
  storage: AccountStorage;
  cipher: StoreCipher;
}): AccountStore {
  const { storage, cipher } = opts;

  // The document as stored, or null for nothing, unreadable or
  // corrupt (all of which read as signed out with nothing remembered;
  // the next write overwrites).
  function readDoc(): StoredShape | SignedOutShape | null {
    const raw = storage.readRaw();
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as StoredShape | SignedOutShape;
      return parsed && parsed.v === 1 ? parsed : null;
    } catch {
      return null;
    }
  }

  function decrypt(stored: {
    enc: boolean;
    credential: string;
    accountId: string;
  }): { credential: string; accountId: string } | null {
    if (
      typeof stored.credential !== "string" ||
      typeof stored.accountId !== "string"
    ) {
      return null;
    }
    try {
      return {
        credential: stored.enc
          ? cipher.decrypt(stored.credential)
          : stored.credential,
        accountId: stored.accountId,
      };
    } catch {
      // Decrypt failure (keychain rotated, moved machine) is
      // unrecoverable for this credential. Treat it as signed out so
      // the user can sign in again.
      return null;
    }
  }

  function encrypt(credential: string): { enc: boolean; credential: string } {
    return {
      enc: cipher.available,
      credential: cipher.available ? cipher.encrypt(credential) : credential,
    };
  }

  function signedOutDoc(): SignedOutShape | null {
    const doc = readDoc();
    return doc !== null && "signedOut" in doc ? doc : null;
  }

  // The one writer of the signed-out remainder.
  function setSignedOut(
    deviceName: string,
    deviceIcon: DeviceIcon | undefined,
    parked?: SignedOutShape["parked"],
  ): void {
    const doc: SignedOutShape = { v: 1, signedOut: true, deviceName };
    if (deviceIcon !== undefined) doc.deviceIcon = deviceIcon;
    if (parked !== undefined) doc.parked = parked;
    storage.writeRaw(JSON.stringify(doc));
  }

  return {
    read() {
      const doc = readDoc();
      if (
        doc === null ||
        "signedOut" in doc ||
        typeof doc.deviceName !== "string"
      ) {
        return null;
      }
      const opened = decrypt(doc);
      return opened === null ? null : withIdentity(doc, opened);
    },

    write(account) {
      const doc: StoredShape = {
        v: 1,
        ...encrypt(account.credential),
        accountId: account.accountId,
        deviceName: account.deviceName,
      };
      if (account.deviceIcon !== undefined) doc.deviceIcon = account.deviceIcon;
      storage.writeRaw(JSON.stringify(doc));
    },

    signedIn() {
      return this.read() !== null;
    },

    clear() {
      const doc = readDoc();
      // The remainder is a nicety, the sign-out is not. A remainder
      // that cannot be written falls back to removing the document,
      // which the backing swallows.
      try {
        if (doc !== null) {
          setSignedOut(
            typeof doc.deviceName === "string" ? doc.deviceName : "",
            iconOf(doc),
            "signedOut" in doc ? doc.parked : undefined,
          );
          return;
        }
      } catch {
        // Fall through to the removal.
      }
      storage.removeRaw();
    },

    rememberedDeviceName() {
      const doc = readDoc();
      if (doc === null || typeof doc.deviceName !== "string") return null;
      return doc.deviceName === "" ? null : doc.deviceName;
    },

    rememberedDeviceIcon() {
      const doc = readDoc();
      return doc === null ? null : (iconOf(doc) ?? null);
    },

    park(account) {
      // Like clear: a parking that cannot be written still signs out.
      try {
        setSignedOut(account.deviceName, account.deviceIcon, {
          ...encrypt(account.credential),
          accountId: account.accountId,
        });
      } catch {
        storage.removeRaw();
      }
    },

    readParked() {
      const doc = signedOutDoc();
      if (doc === null || doc.parked === undefined) return null;
      const opened = decrypt(doc.parked);
      return opened === null ? null : withIdentity(doc, opened);
    },

    clearParked() {
      const doc = signedOutDoc();
      if (doc?.parked !== undefined) setSignedOut(doc.deviceName, iconOf(doc));
    },
  };
}
