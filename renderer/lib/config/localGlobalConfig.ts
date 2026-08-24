// Read-modify-write for the local global config, used by the hosting and
// remote-device settings sections (v2 step 3, slice C). Those sections
// own keys the redacted read cannot round-trip: socketHost.token and the
// remoteDevices tokens. The CLI write is whole document for its
// registered keys, so an omitted socketHost.token is DELETED, which is
// why the base MUST be the unredacted readLocal doc rather than the
// redacted read the rest of settings is built from.
//
// The token bearing base is read imperatively here and handed straight
// to the write. It never enters the React Query cache, so the secrets
// stay off the cache entirely.
import type { GlobalConfig } from "@shared/schemas";

// Fetch the unredacted local doc, apply update, write the full result.
// The update receives the whole base and returns the whole document to
// persist, so it can preserve or replace socketHost and remoteDevices
// while every other key rides through untouched.
export async function updateLocalGlobalConfig(
  update: (base: GlobalConfig) => GlobalConfig,
): Promise<void> {
  const base = await window.api.globalConfig.readLocal();
  await window.api.globalConfig.write(update(base));
}
