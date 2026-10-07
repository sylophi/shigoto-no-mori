# contracts

The shared contracts: Schema, the RPC groups, the tagged errors and the protocol version. They move here from `app/shared/schemas`, `app/shared/ipc`, `app/shared/hub/protocol.ts` and `app/shared/errors.ts` in step 1 of `V3.md`.

`fixtures/` holds the JSON each schema module accepts, produces and refuses, one file per module, so a rewrite of a schema cannot change what crosses a wire or sits on disk. `app/test/schema-fixtures.mts` checks it until the schemas move here.
