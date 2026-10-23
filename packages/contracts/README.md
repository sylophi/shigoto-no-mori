# contracts

What crosses a wire or sits on disk, described once for every side: the app's main process, host and renderer, the web client and the hub.

- `src/schemas/`: the data shapes, as Effect Schema, with `strict` and `loose` for contract payloads and `index.ts` as their barrel.
- `src/modules/`: one contract per module, an `RpcGroup` of the calls and pushes each side serves, each tagged with its channel and classified by annotations (`src/contract.ts`). `src/grants.ts` holds the consent lines a remote gated call names. `src/types.ts` derives the client and handler types from the groups, and `src/codec.ts` holds `decode`, `safeDecode` and the `Encoded`/`Decoded` types.
- `src/hubApi.ts`: the hub Worker's HTTP API, the refusals no window tells apart, and its two bearer tiers, which the Worker serves and the app calls through the derived client.
- `src/hubProtocol.ts`: the bodies that API carries, the socket envelopes between a device and the hub, and the connectInfo ask and answer the devices relay through it.
- `src/errors.ts`: the errors a contract names and the renderer recognizes, the hub's refusals of this device among them, which cross every wire as themselves.
- The host serves a host-scoped module through its handler map, `app/host/ipc/modules/<module>.ts`, which `app/host/process/handlers.ts` registers; the shell serves a client-scoped one (`app/main/ipc/modules/`). A call's annotations say who may make it, and the registrar fails closed on one that is missing: a host invoke says `remote` (true only if a peer may call it), a remote one says `gated` (true for anything that changes what the user owns, and for the reads `src/contract.ts` lists), and a remote gated one names the consent line that covers it (`grant`, from `src/grants.ts`). `tracksProjectUsage` and `busy` (what a quit waits on the call for) are opt-in (`src/contract.ts` says when). After changing any of them, run `classification` and read its diff (below).
- `src/link.ts`: the device link's `RpcGroup`, every module's remote calls plus the link's own (`src/modules/link.ts`), and the middleware tags that guard it. `src/allModules.ts` lists the modules it is built from, and `ChannelRefusedError` (`src/errors.ts`) the reasons a byte channel's open is refused with.
- `src/sharedSettings.ts`, `src/leaveOutRule.ts`, `src/pullRequestStack.ts`, `src/releaseVersions.ts`, `src/accountServiceConfig.ts`: the rules two sides must apply the same way (the shared settings' merge, a mirror's leave-out rule, stacked pull requests, release precedence and the changelog, the account's build configuration), as pure functions over the schemas. A module's schema and its contract keep the same name under `src/schemas/` and `src/modules/`.
- `src/predicates/`, `src/deviceIcon.ts`, `src/platform.ts`, `src/mirrorIgnores.ts`: the values and checks the schemas are built from, which the app uses too.
- `src/git/` (branch names, matching git's ignored paths, worktree layout paths), `src/projectPaths.ts`, `src/scriptEnv.ts`, `src/lifecycleScripts.ts` (what a lifecycle slot runs) and `src/mediaTypes.ts`: pure helpers the host and the views both read, kept here because every side can compile the contracts and nothing else.

Consumers import a module by its path under `src/`, without the extension: `@shigomori/contracts/modules/sync`, `@shigomori/contracts/predicates/webUrl`. The schemas also come as one barrel, `@shigomori/contracts/schemas`. Inside the package, imports are relative with the `.ts` extension.

The package's runtime dependencies are `effect` and `semver`, and it imports nothing from the app, so every side can compile it. Release versions are read by `semver` (`src/releaseVersions.ts`, which adds a prerelease's channel).

`fixtures/` holds the JSON each schema module accepts, produces and refuses, one file per module, so a rewrite of a schema cannot change what crosses a wire or sits on disk. `test/fixtures.test.ts` checks it (`pnpm run check:contracts` from the root).

## Wire samples

`src/protocol.ts` holds the protocol version, and `fixtures/wire/v<version>.json` one encoded sample of every part each call sends: an invoke's payload and result, a push's payload, a view's payload and value. `test/wire.test.ts` checks that every call has its samples and that each still decodes and goes back to exactly itself, so a schema change that leaves this build unable to read what an older build sends fails there. Such a change bumps the version, and the samples file is replaced by one for the new version.

The hub's envelopes and HTTP bodies (`src/hubProtocol.ts`) follow the same rule: a change an older build cannot read bumps the version, since the hub's floor is the version (`HUB_PROTOCOL_FLOOR`) and turns away every build below it.

The samples prove one direction: this build reads what the version's samples hold. The other, that an older build of the same version reads everything this one sends, is the rule a reviewer holds:

- No bump: a new call (an older build answers a call it lacks with a defect for that call alone, and the link stays up), and a new optional field in a plain struct or a `loose` one, which an older build drops or keeps as it came. Nor any change to a `client` module's calls, which only a window and its own build's shell exchange, or to `session`'s, which only a host and the shell that spawned it exchange (its samples are edited in place).
- A bump: anything an older build decodes and would refuse or misread. A new field in a `strict` schema (strict refuses a key it does not model), a field or call removed or renamed, a type narrowed, a new literal or union member, a new error in `CallFailureSchema` (an older build cannot decode it), or a change to the encoding.

To bump, raise `PROTOCOL_VERSION`, `git mv` the samples file to the new version's name, and run `wire-fixtures`. The hub deploys with the bump, since its floor is the version.

A version no build has been cut with yet takes its changes in place: its samples file is edited and the version stays, since no build of it exists to read the old bytes. Once a build carries the version, the rules above hold for it. A device on another version never links (the device link's hello asks for its own exactly), so a field a version makes optional is optional for its meaning, never for an older peer.

`pnpm -F @shigomori/contracts wire-fixtures` adds a sample derived from the schema for each part that has none, asks for one by hand where a schema's checks leave nothing to derive, and drops the samples of calls and parts that are gone. It never rewrites a sample that is there, and it formats the file as the repo does (oxfmt), so the diff is the samples it added or dropped. `test/wire.test.ts` also refuses a channel named twice in the file, which `JSON.parse` would hide.

## Classification

`fixtures/wire/classification.json` holds what every call of every module may do over a wire: its kind (invoke, push or view), its module's scope, and each annotation it carries (`remote`, `gated`, `grant`, `tracksProjectUsage`, `busy`), an annotation it lacks left out. `test/classification.test.ts` derives the same from the contract and fails with the diff when they differ. So a read that becomes a command, a call that joins or leaves the remote surface, or a grant that moves shows up as a reviewed change to what the device link hands to other devices.

Unlike the samples, the file is the contract's own reading, so `pnpm -F @shigomori/contracts classification` writes it whole. Run it when the change is meant, and read its diff.
