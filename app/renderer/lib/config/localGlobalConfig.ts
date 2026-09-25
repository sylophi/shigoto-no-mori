// Read-modify-write for the local global config.
// The config can carry a key the redacted read cannot round-trip:
// socketHost.token, engine-level and CLI-writable even though no UI
// edits it. The CLI write is whole document for its registered keys, so
// an omitted socketHost.token is DELETED, which is why the base MUST be
// the unredacted readLocal doc rather than the redacted read the rest
// of settings is built from.
//
// The token bearing base is read imperatively here and handed straight
// to the write. It never enters the React Query cache, so the secrets
// stay off the cache entirely.
import type { GlobalConfig } from "@shared/schemas";

// Module-level serializer so every global-config write queues through
// one path. One caller today (the settings save), but a save
// read-modify-writes the WHOLE document, so two overlapping runs would
// each read the same base and the second to land would clobber the
// first's. The next task's readLocal runs only after the prior task's
// write resolved, and the write handler drops the host read cache
// before it resolves, so each base reflects the write before it.
let writeChain: Promise<unknown> = Promise.resolve();

// Fetch the unredacted local doc, apply update, write the full result.
// The update receives the whole base and returns the whole document to
// persist, so it can preserve or replace socketHost while every other
// key rides through untouched. Serialized through
// writeChain so concurrent callers see each other's writes.
export function updateLocalGlobalConfig(
  update: (base: GlobalConfig) => GlobalConfig,
): Promise<void> {
  const run = writeChain.then(async () => {
    const base = await window.api.globalConfig.readLocal();
    await window.api.globalConfig.write(update(base));
  });
  // Keep the chain alive past a rejected write so one failure does not
  // wedge every later write. The caller still sees run's rejection.
  writeChain = run.catch(() => undefined);
  return run;
}
