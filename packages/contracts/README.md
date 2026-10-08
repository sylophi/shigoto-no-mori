# contracts

What crosses a wire or sits on disk, described once for every side: the app's main process, host and renderer, the web client and the hub.

- `src/schemas/`: the data shapes, as Effect Schema, with `strict` and `loose` for contract payloads and `index.ts` as their barrel.
- `src/modules/`: one contract per module, an `RpcGroup` of the calls and pushes each side serves, each tagged with its channel and classified by annotations (`src/contract.ts`). `src/grants.ts` holds the consent lines a remote gated call names. `src/types.ts` derives the client and handler types from the groups, and `src/codec.ts` holds `decode`, `safeDecode`, `encode` and the `Encoded`/`Decoded` types.
- `src/hubProtocol.ts`: the device-to-hub wire.
- `src/errors.ts`: the errors a contract names and the renderer recognizes.
- `src/predicates/`, `src/deviceIcon.ts`, `src/platform.ts`, `src/mirrorIgnores.ts`: the values and checks the schemas are built from, which the app uses too.

Consumers import a module by its path under `src/`, without the extension: `@shigomori/contracts/modules/sync`, `@shigomori/contracts/predicates/webUrl`. The schemas also come as one barrel, `@shigomori/contracts/schemas`. Inside the package, imports are relative with the `.ts` extension.

The package has no runtime dependency besides `effect` and imports nothing from the app, so every side can compile it.

`fixtures/` holds the JSON each schema module accepts, produces and refuses, one file per module, so a rewrite of a schema cannot change what crosses a wire or sits on disk. `test/fixtures.test.ts` checks it (`pnpm run check:contracts` from the root).

`src/protocol.ts` holds the protocol version, and `fixtures/wire/v<version>.json` one encoded sample of every call's payload, result and push. `test/wire.test.ts` checks that every call has its samples and that each decodes and encodes back unchanged, so a schema change an older build could not read fails there and bumps the version. `pnpm -F @shigomori/contracts wire-fixtures` adds samples for new calls (derived from their schemas, or asks for one by hand where a schema's checks leave nothing to derive) and drops those of calls that are gone. It never rewrites a sample that is there.
