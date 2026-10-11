# contracts

What crosses a wire or sits on disk, described once for every side: the app's main process, host and renderer, the web client and the hub.

- `src/schemas/`: the data shapes, as Effect Schema, with `strict` and `loose` for contract payloads and `index.ts` as their barrel.
- `src/modules/`: one contract per module, an `RpcGroup` of the calls and pushes each side serves, each tagged with its channel and classified by annotations (`src/contract.ts`). `src/grants.ts` holds the consent lines a remote gated call names. `src/types.ts` derives the client and handler types from the groups, and `src/codec.ts` holds `decode`, `safeDecode`, `encode` and the `Encoded`/`Decoded` types.
- `src/hubApi.ts`: the hub Worker's HTTP API, its refusals and its two bearer tiers, which the Worker serves and the app calls through the derived client.
- `src/hubProtocol.ts`: the bodies that API carries, the socket envelopes between a device and the hub, and the connectInfo ask and answer the devices relay through it.
- `src/errors.ts`: the errors a contract names and the renderer recognizes.
- `src/predicates/`, `src/deviceIcon.ts`, `src/platform.ts`, `src/mirrorIgnores.ts`: the values and checks the schemas are built from, which the app uses too.
- `src/git/` (branch names, repo-relative paths, worktree layout paths), `src/projectPaths.ts` and `src/scriptEnv.ts`: pure helpers the host and the views both read, kept here because every side can compile the contracts and nothing else.

Consumers import a module by its path under `src/`, without the extension: `@shigomori/contracts/modules/sync`, `@shigomori/contracts/predicates/webUrl`. The schemas also come as one barrel, `@shigomori/contracts/schemas`. Inside the package, imports are relative with the `.ts` extension.

The package has no runtime dependency besides `effect` and imports nothing from the app, so every side can compile it.

`fixtures/` holds the JSON each schema module accepts, produces and refuses, one file per module, so a rewrite of a schema cannot change what crosses a wire or sits on disk. `test/fixtures.test.ts` checks it (`pnpm run check:contracts` from the root).

## Wire samples

`src/protocol.ts` holds the protocol version, and `fixtures/wire/v<version>.json` one encoded sample of every part each call sends: an invoke's payload and result, a push's payload, a view's payload and value. `test/wire.test.ts` checks that every call has its samples and that each still decodes and goes back to exactly itself, so a schema change that leaves this build unable to read what an older build sends fails there. Such a change bumps the version, and the samples file is replaced by one for the new version.

The hub's envelopes and HTTP bodies (`src/hubProtocol.ts`) follow the same rule: a change an older build cannot read bumps the version, since the hub's floor is the version (`HUB_PROTOCOL_FLOOR`) and turns away every build below it.

The samples prove one direction: this build reads what the version's samples hold. That an older build of the same version reads everything this one sends (a new optional field in a strict result, a new literal) is the reviewer's call, and a bump when it cannot.

`pnpm -F @shigomori/contracts wire-fixtures` adds a sample derived from the schema for each part that has none, asks for one by hand where a schema's checks leave nothing to derive, and drops the samples of calls and parts that are gone. It never rewrites a sample that is there.

## Classification

`fixtures/wire/classification.json` holds what every call of every module may do over a wire: its kind (invoke, push or view), its module's scope, and each annotation it carries (`remote`, `gated`, `grant`, `invitable`, `tracksProjectUsage`), an annotation it lacks left out. `test/classification.test.ts` derives the same from the contract and fails with the diff when they differ. So a read that becomes a command, a call that joins or leaves the remote surface, or a grant that moves shows up as a reviewed change to what the device link hands to other devices.

Unlike the samples, the file is the contract's own reading, so `pnpm -F @shigomori/contracts classification` writes it whole. Run it when the change is meant, and read its diff.
