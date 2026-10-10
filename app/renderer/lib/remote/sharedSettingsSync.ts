// Keeps this device's copy of the shared settings
// (packages/contracts/src/schemas/sharedSettings.ts) level with its peers', boot-scoped
// like the other remote subscriptions. No server holds the settings:
// every device keeps a full copy, and the copies converge by merging
// (contracts' sharedSettings.ts), which is order-free and idempotent, so
// the exchange needs no sessions, acks or retries. A device that was
// away catches up the next time any session with it lands.
//
// Three moves, all through the local copy:
//
//   - A peer's copy moved (its sharedSettings:changed push, carrying
//     the copy whole, followed from its first session landing): merge
//     it into the local copy. A merge that
//     learns something makes the local host announce in turn, one that
//     learns nothing announces nothing, and that is what ends the
//     round.
//   - A session landed: read the peer's copy and merge it, covering
//     every push missed while the session was down, then offer back
//     whatever the local copy holds that the peer's lacks.
//   - A pick made here (writeSharedSetting): written to the local copy,
//     then offered to every peer in reach.
//
// Pulling is what convergence rests on, because a read is served to
// any account peer. Offering is a push, which a peer refuses unless it
// accepts commands, so it is best-effort and silent. It exists for the
// one copy nobody can pull from: a browser serves no calls, so its
// picks travel only by being offered. (A desktop always has a window
// to do its pulling: the app quits with its last one.) The window reads
// the local copy as its view streams it
// (hooks/sharedSettings/useSharedSettings.ts).
import type { QueryClient } from "@tanstack/react-query";
import type {
  SharedSettingsDoc,
  SharedSettingValue,
} from "@shigomori/contracts/schemas";
import {
  exchangeSharedSettings,
  sharedSettingKeys,
} from "@shigomori/contracts/sharedSettings";
import { clientConfigQueryOptions } from "@/hooks/config/useClientConfig";
import { mergeClientConfigWrite } from "@/hooks/config/mergeClientConfigWrite";
import { queryKeys } from "@/lib/queryKeys";
import { deviceStatusView } from "@shigomori/ui/lib/deviceStatus.ts";
import { remoteDeviceStore } from "./devices";
import { apiFor, onAccountLeft, onSessionLanded } from "./remoteDeviceSync";

// Offers entries to every peer in reach. Best-effort by design (see the
// header): a peer with no grant and a session that just dropped both
// refuse, and each is caught up by a pull instead.
function offerToPeers(doc: SharedSettingsDoc): void {
  if (Object.keys(doc.entries).length === 0) return;
  for (const device of remoteDeviceStore.getSnapshot()) {
    if (!deviceStatusView(device.status).reachable) continue;
    device.api?.sharedSettings.merge({ doc }).catch(() => undefined);
  }
}

// The write path for every shared setting: the local copy first, so
// the pick holds here whatever the network is doing, then an offer to
// each peer with a session.
export async function writeSharedSetting(
  key: string,
  value: SharedSettingValue,
): Promise<SharedSettingsDoc> {
  const doc = await window.api.sharedSettings.set({ key, value });
  const entry = doc.entries[key];
  if (entry !== undefined) offerToPeers({ entries: { [key]: entry } });
  return doc;
}

// A peer's copy moved: fold it into the local copy. Unconditional on
// purpose. The host settles an echo cheaply, and asking it every time
// is what lets a local copy that was reset behind the window fill back
// in. The peer's client decoded the copy (shared/ipc/buildClient.ts).
function mergePeerSharedSettings(doc: SharedSettingsDoc): void {
  window.api.sharedSettings.merge({ doc }).catch(() => undefined);
}

// The create-device picks lived in client config before they were
// shared (clientConfig.quickCreateDevices). Moved across once: each
// becomes an entry with the lowest stamp there is, so a pick made
// through the shared path on any device outranks every migrated one,
// and then the old key is cleared. Two devices that had picked
// differently settle on one of the two by device id: they were never
// one setting, and nothing recorded which pick was the later.
async function migrateQuickCreateDevices(
  queryClient: QueryClient,
): Promise<void> {
  const config = await queryClient.fetchQuery(clientConfigQueryOptions);
  const legacy = config.quickCreateDevices;
  if (legacy === undefined) return;
  const entries: SharedSettingsDoc["entries"] = {};
  for (const [identity, deviceId] of Object.entries(legacy)) {
    entries[sharedSettingKeys.quickCreateDevice(identity)] = {
      value: deviceId,
      at: 0,
      by: window.api.deviceId,
    };
  }
  await window.api.sharedSettings.merge({ doc: { entries } });
  // Offered like any pick: a browser's copy reaches its peers no other
  // way, and the sessions may have landed while this was reading.
  offerToPeers({ entries });
  queryClient.setQueryData(
    queryKeys.clientConfig(),
    await mergeClientConfigWrite(queryClient, {
      quickCreateDevices: undefined,
    }),
  );
}

// Boot wiring, never unsubscribed.
export function startSharedSettingsSync(queryClient: QueryClient): void {
  // Each peer's pushes are followed from its first landing on, which
  // is also the first moment it can push at all, and the exchange that
  // runs on every landing covers whatever it sent while unfollowed.
  const followed = new Map<string, () => void>();
  onAccountLeft(() => {
    for (const unfollow of followed.values()) unfollow();
    followed.clear();
  });
  onSessionLanded((deviceId) => {
    const peer = apiFor(deviceId).sharedSettings;
    if (!followed.has(deviceId)) {
      followed.set(deviceId, peer.onChanged(mergePeerSharedSettings));
    }
    exchangeSharedSettings(window.api.sharedSettings, peer).catch(
      () => undefined,
    );
  });
  migrateQuickCreateDevices(queryClient).catch((error: unknown) => {
    console.warn("[sharedSettings] create-device migration failed", error);
  });
}
