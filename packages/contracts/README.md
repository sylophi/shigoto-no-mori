# contracts

What crosses a wire or sits on disk, described once for every side: the app's main process, host and renderer, the web client and the hub.

- `src/schemas/`: the data shapes, as Effect Schema, with `strict` and `loose` for contract payloads and `index.ts` as their barrel.
- `src/modules/`: one contract per module, an `RpcGroup` of the calls and pushes each side serves, each tagged with its channel and classified by annotations (`src/contract.ts`). `src/grants.ts` holds the consent lines a remote gated call names. `src/types.ts` derives the client and handler types from the groups.
- `src/hubApi.ts`: the hub Worker's HTTP API, the refusals no window tells apart, and its two bearer tiers, which the Worker serves and the app calls through the derived client.
- `src/hubProtocol.ts`: the bodies that API carries, the socket envelopes between a device and the hub, and the connectInfo ask and answer the devices relay through it.
- `src/errors.ts`: the errors a contract names and the renderer recognizes, the hub's refusals of this device among them, which cross every wire as themselves.
- The host serves a host-scoped module through its handler map, `app/host/ipc/modules/<module>.ts`, which `app/host/process/handlers.ts` gathers into the layer the host's listeners serve. The shell serves a client-scoped one (`app/main/ipc/modules/`). A call's annotations say who may make it, and `defineContract` throws as the module loads when a host call lacks one: a host invoke or view says `remote` (true only if a peer may call it, and said once for a module on the loopback alone, as `{ scope: "host", remote: false }`), a remote one says `gated` (true for anything that changes what the user owns, and for the reads `src/contract.ts` lists), and a remote gated one names the consent line that covers it (`grant`, from `src/grants.ts`). `tracksProjectUsage` and `busy` (what a quit waits on the call for) are opt-in (`src/contract.ts` says when).
- `src/link.ts`: the device link's `RpcGroup`, every module's remote calls plus the link's own (`src/modules/link.ts`), and the middleware tags that guard it. `src/allModules.ts` lists the modules it is built from, and `ChannelRefusedError` (`src/errors.ts`) the reasons a byte channel's open is refused with.
- `src/sharedSettings.ts`, `src/leaveOutRule.ts`, `src/pullRequestStack.ts`, `src/releaseVersions.ts`, `src/accountServiceConfig.ts`: the rules two sides must apply the same way (the shared settings' merge, a mirror's leave-out rule, stacked pull requests, release precedence and the changelog, the account's build configuration), as pure functions over the schemas. A module's schema and its contract keep the same name under `src/schemas/` and `src/modules/`.
- `src/predicates/`, `src/deviceIcon.ts`, `src/platform.ts`, `src/mirrorIgnores.ts`: the values and checks the schemas are built from, which the app uses too.
- `src/git/` (branch names, matching git's ignored paths, worktree layout paths), `src/projectPaths.ts`, `src/scriptEnv.ts`, `src/lifecycleScripts.ts` (what a lifecycle slot runs) and `src/mediaTypes.ts`: pure helpers the host and the views both read, kept here because every side can compile the contracts and nothing else.

Consumers import a module by its path under `src/`, without the extension: `@shigomori/contracts/modules/sync`, `@shigomori/contracts/predicates/webUrl`. The schemas also come as one barrel, `@shigomori/contracts/schemas`. Inside the package, imports are relative with the `.ts` extension.

The package's runtime dependencies are `effect` and `semver`, and it imports nothing from the app, so every side can compile it. Release versions are read by `semver` (`src/releaseVersions.ts`, which adds a prerelease's channel).

`fixtures/` holds the JSON each schema module accepts, produces and refuses, one file per module, so a rewrite of a schema cannot change what crosses a wire or sits on disk. `test/fixtures.test.ts` checks it (`pnpm run check:contracts` from the root).

## Wire samples

What crosses the wire between two builds is versioned in parts (`src/protocol.ts`), so two devices on different releases keep their link and lose only what changed.

The core is what any link needs: the hello and the byte channels (`src/modules/link.ts`), the frame encoding, the failure union (`CallFailureSchema`) and the hub's wire (`src/hubProtocol.ts`). Its version is `CORE_VERSION`. Two builds on different cores hold no link at all (the host's hello refuses any core but its own), and the hub turns away every build below it (`HUB_PROTOCOL_FLOOR`).

Every other module a build of another release calls names a version in its `defineContract`: a module a peer reaches, and the ones the terminal `sm` calls on its own machine's app. A host's welcome carries the version of each module it serves. The dialing end holds them against its own (`outdatedCall` in `src/link.ts`) and refuses a call into a module at another version before it is sent, with a `ModuleOutdatedError` naming the module and the end on the older build. Such a module's pushes are never asked for. Every call, view and push of a link is asked for by its dialing end, so that is the one place a call is refused. `mirror` and `sync` share `MIRROR_VERSION`: a mirror runs on sync's calls, so the two change as one.

`fixtures/wire/<module>.v<version>.json` holds one encoded sample of every part each of a module's versioned calls sends: an invoke's payload and result, a push's payload, a view's payload and value. `test/wire.test.ts` checks that every call has its samples and that each still decodes and goes back to exactly itself, so a schema change that leaves this build unable to read what an older build of that version sends fails there. Such a change bumps the module's version, and its samples file is replaced by one for the new version. A schema several modules share fails each of them, and each bumps.

`fixtures/wire/local.json` holds the samples of the calls only one build's own processes exchange: a `client` module's, which a window and its own build's shell exchange (its remote calls apart), and those of a module with no version, like `session`, which a host and the shell that spawned it exchange. They are edited in place.

The samples prove one direction: this build reads what the version's samples hold. The other, that an older build of the same version reads everything this one sends, is the rule a reviewer holds:

- No bump: a new call (an older build answers a call it lacks with a defect for that call alone), and a new optional field in a plain struct or a `loose` one, which an older build drops or keeps as it came.
- A bump of the module: anything an older build decodes and would refuse or misread. A new field in a `strict` schema (strict refuses a key it does not model), a field or call removed or renamed, a type narrowed, a new literal or union member.
- A bump of the core: a change to the hello or the byte channels, a new error in `CallFailureSchema` (an older build cannot decode it), a change to the encoding, and a change to the hub's envelopes or HTTP bodies an older build cannot read.

The core is kept still, since a bump of it cuts every device on an older release off until it is updated by hand. The hello's payload keeps its shape: it is what a build on another core reads before it refuses. The welcome is a plain struct, so it can say more. A new kind of failure crosses as a `RemoteCallError` with a `code` until a core bump is due anyway.

To bump a module, raise its version, `git mv` its samples file to the new version's name, and run `wire-fixtures`. A bump of the core is the same on `link.v<version>.json`, and the hub's floor is the core, so the hub's next deploy turns away every build below it: deploy it only once a release with the bump has reached the devices (`hub/README.md`, "The version floor").

A version no build has been cut with yet takes its changes in place: its samples file is edited and the version stays, since no build of it exists to read the old bytes. Once a build carries the version, the rules above hold for it. A call into a module at another version is never sent, so a field a version makes optional is optional for its meaning, never for an older peer.

`pnpm -F @shigomori/contracts wire-fixtures` adds a sample derived from the schema for each part that has none, asks for one by hand where a schema's checks leave nothing to derive, and drops the samples of calls and parts that are gone. It never rewrites a sample that is there, and it formats the files as the repo does (oxfmt), so the diff is the samples it added or dropped. It writes nothing while a bumped version's samples file has not been moved to its new name. `test/wire.test.ts` also refuses a samples file no module's version names, and a channel named twice in a file, which `JSON.parse` would hide.
