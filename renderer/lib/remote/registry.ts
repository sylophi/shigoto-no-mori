// Boot and post-write reconcile for the remote device registry (v2 step
// 3, slice C). The registry connects OUT to the devices listed in the
// local config's remoteDevices. That list carries per device tokens, so
// it rides only on the local unredacted readLocal path, never the
// redacted read a peer can call.
//
// The token bearing document is read imperatively here and handed
// straight to reconcileRemoteDevices, which keeps the tokens in the
// registry's module state. It is deliberately never parked in a
// broadly-cached query, so the secrets stay out of the React Query
// cache entirely.
import { reconcileRemoteDevices } from "./devices";

// Read the local unredacted config and reconcile the device registry
// against its remoteDevices list. Call once at boot, and again after any
// write that changes remoteDevices so the registry connects new entries
// and drops removed ones.
export async function reconcileRemoteDevicesFromConfig(): Promise<void> {
  const config = await window.api.globalConfig.readLocal();
  reconcileRemoteDevices(config.remoteDevices ?? []);
}
