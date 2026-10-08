// The Clerk bridge's session tokens, kept in userData and encrypted at
// rest with safeStorage. The file and its values are the ones the
// Clerk SDK's electron-store adapter wrote, so a sign-in survives the
// upgrade and the dev launchers can still clone it
// (scripts/lib/devProfile.mts): one JSON object, tab-indented, each
// value `enc:` and the base64 ciphertext. When the OS offers no
// encryption a token is not persisted, and the user signs in again on
// the next launch.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import { safeStorage } from "electron";
import { CLERK_TOKEN_STORE } from "@shared/packaging/appName.mts";

const ENCRYPTED_PREFIX = "enc:";
const RAW_PREFIX = "raw:";

type Cipher = {
  readonly encrypt: (value: string) => Promise<string>;
  readonly decrypt: (
    payload: string,
  ) => Promise<{ value: string; shouldReEncrypt: boolean }>;
};

// Electron's async safeStorage when it reports itself available (a
// signed build), else the synchronous one, else none.
async function resolveCipher(): Promise<Cipher | null> {
  try {
    if (await safeStorage.isAsyncEncryptionAvailable()) {
      return {
        encrypt: async (value) =>
          (await safeStorage.encryptStringAsync(value)).toString("base64"),
        decrypt: async (payload) => {
          const { result, shouldReEncrypt } =
            await safeStorage.decryptStringAsync(
              Buffer.from(payload, "base64"),
            );
          return { value: result, shouldReEncrypt };
        },
      };
    }
  } catch {
    // Fall through to the synchronous API.
  }
  if (!safeStorage.isEncryptionAvailable()) return null;
  return {
    encrypt: async (value) =>
      safeStorage.encryptString(value).toString("base64"),
    decrypt: async (payload) => ({
      value: safeStorage.decryptString(Buffer.from(payload, "base64")),
      shouldReEncrypt: false,
    }),
  };
}

export class ClerkTokens extends Context.Service<
  ClerkTokens,
  {
    readonly getItem: (key: string) => Effect.Effect<string | null>;
    readonly setItem: (key: string, value: string) => Effect.Effect<void>;
    readonly removeItem: (key: string) => Effect.Effect<void>;
  }
>()("sm/desktop/ClerkTokens") {}

const TokenFileSchema = Schema.Record(Schema.String, Schema.String);
const decodeTokenFile = Schema.decodeUnknownOption(
  Schema.fromJsonString(TokenFileSchema),
);

// A string store over the one JSON file, read once: main is its only
// writer. Each write replaces the file through a rename, so a crash
// mid-write leaves the previous one.
const jsonFileStore = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs
    .readFileString(file)
    .pipe(Effect.orElseSucceed(() => "{}"));
  const entries = new Map(
    Object.entries(Option.getOrElse(decodeTokenFile(text), () => ({}))),
  );
  const write = Effect.suspend(() => {
    const temp = `${file}.tmp`;
    return fs
      .makeDirectory(path.dirname(file), { recursive: true })
      .pipe(
        Effect.andThen(
          fs.writeFileString(
            temp,
            JSON.stringify(Object.fromEntries(entries), undefined, "\t"),
            { mode: 0o666 },
          ),
        ),
        Effect.andThen(fs.rename(temp, file)),
      );
  }).pipe(
    Effect.mapError(
      (cause) =>
        new KeyValueStore.KeyValueStoreError({
          message: "Could not write the Clerk token file.",
          method: "write",
          cause,
        }),
    ),
  );
  return KeyValueStore.makeStringOnly({
    get: (key) => Effect.sync(() => entries.get(key)),
    set: (key, value) =>
      Effect.suspend(() => {
        entries.set(key, value);
        return write;
      }),
    remove: (key) =>
      Effect.suspend(() => (entries.delete(key) ? write : Effect.void)),
    clear: Effect.suspend(() => {
      entries.clear();
      return write;
    }),
    size: Effect.sync(() => entries.size),
  });
});

const make = Effect.fnUntraced(function* (file: string) {
  const store = yield* jsonFileStore(file);
  // Kept once one resolves. None is asked again next time, since a
  // keyring can come up after launch.
  const resolved = yield* Ref.make<Cipher | null>(null);
  const getCipher = Ref.get(resolved).pipe(
    Effect.flatMap((cipher) =>
      cipher !== null
        ? Effect.succeed(cipher)
        : Effect.promise(resolveCipher).pipe(
            Effect.tap((next) =>
              next === null ? Effect.void : Ref.set(resolved, next),
            ),
          ),
    ),
  );
  const warnUnencrypted = yield* Effect.cached(
    Effect.logWarning(
      "[clerk] OS encryption is unavailable, so the session token is not kept and the next launch signs in again",
    ),
  );

  const getItem = Effect.fn("ClerkTokens.getItem")(function* (key: string) {
    const stored = yield* store
      .get(key)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (stored === undefined || stored === "") return null;
    if (stored.startsWith(RAW_PREFIX)) return stored.slice(RAW_PREFIX.length);
    if (!stored.startsWith(ENCRYPTED_PREFIX)) {
      yield* store.remove(key).pipe(Effect.ignore);
      return null;
    }
    const decrypt = yield* getCipher;
    if (decrypt === null) return null;
    const payload = stored.slice(ENCRYPTED_PREFIX.length);
    const decrypted = yield* Effect.tryPromise(() =>
      decrypt.decrypt(payload),
    ).pipe(Effect.option);
    if (Option.isNone(decrypted)) return null;
    const { value, shouldReEncrypt } = decrypted.value;
    if (shouldReEncrypt) {
      yield* Effect.tryPromise(() => decrypt.encrypt(value)).pipe(
        Effect.flatMap((ciphertext) =>
          store.set(key, ENCRYPTED_PREFIX + ciphertext),
        ),
        Effect.ignore,
      );
    }
    return value;
  });

  const setItem = Effect.fn("ClerkTokens.setItem")(function* (
    key: string,
    value: string,
  ) {
    const encrypt = yield* getCipher;
    if (encrypt === null) {
      yield* warnUnencrypted;
      return;
    }
    yield* Effect.tryPromise(() => encrypt.encrypt(value)).pipe(
      Effect.flatMap((ciphertext) =>
        store.set(key, ENCRYPTED_PREFIX + ciphertext),
      ),
      Effect.catch(() =>
        Effect.logWarning(
          "[clerk] the session token could not be encrypted and was not kept",
        ),
      ),
    );
  });

  const removeItem = Effect.fn("ClerkTokens.removeItem")(function* (
    key: string,
  ) {
    yield* store.remove(key).pipe(Effect.ignore);
  });

  return ClerkTokens.of({ getItem, setItem, removeItem });
});

export const layer = (userData: string) =>
  Layer.effect(
    ClerkTokens,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      return yield* make(path.join(userData, `${CLERK_TOKEN_STORE}.json`));
    }),
  );
