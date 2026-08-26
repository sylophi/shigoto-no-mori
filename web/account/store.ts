// The browser backing for the shared credential store core: the
// { v:1, enc, credential, accountId, deviceName } envelope persisted as
// one localStorage key. Browsers have no OS keychain, so the cipher is
// permanently unavailable and the core stamps enc:false plaintext
// envelopes, the same fallback a keychain-less desktop uses. That means
// the relay credential sits in plaintext site storage: acceptable for a
// read-only web client whose credential the account owner can revoke
// from any device, and the envelope shape means a future encrypted
// backing slots in without a migration.
import {
  createAccountStore,
  type AccountStore,
  type StoreCipher,
} from "@shared/account/credentialStore";
import {
  readKey,
  removeKey,
  writeKey,
  type KeyValueStorage,
} from "../lib/kvStorage";

const ACCOUNT_KEY = "sm.web.account";

// available:false means the core never calls encrypt or decrypt on the
// write path, and a read of a stray enc:true envelope (copied from
// another platform) fails decryption and reads as signed out rather
// than crashing.
const plaintextCipher: StoreCipher = {
  available: false,
  encrypt: () => {
    throw new Error("the web client has no at-rest cipher");
  },
  decrypt: () => {
    throw new Error("the web client has no at-rest cipher");
  },
};

export function createWebAccountStore(storage: KeyValueStorage): AccountStore {
  return createAccountStore({
    storage: {
      readRaw: () => readKey(storage, ACCOUNT_KEY),
      writeRaw: (text) => writeKey(storage, ACCOUNT_KEY, text),
      removeRaw: () => removeKey(storage, ACCOUNT_KEY),
    },
    cipher: plaintextCipher,
  });
}
