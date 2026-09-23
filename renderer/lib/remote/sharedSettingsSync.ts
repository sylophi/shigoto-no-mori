// Keeps this device's copy of the shared settings
// (shared/schemas/sharedSettings.ts) level with its peers', boot-scoped
// like the other remote subscriptions. No server holds the settings:
// every device keeps a full copy, and the copies converge by merging
// (shared/sharedSettings.ts), which is order-free and idempotent, so
// the exchange needs no sessions, acks or retries. A device that was
// away catches up the next time any session with it lands.
//
// Three moves, all through the local copy:
//
//   - A peer's copy moved (its sharedSettings:changed push, carrying
//     the copy whole, routed here by remoteHostWatch): merge it into
//     the local copy. A merge that
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
// to do its pulling: the app quits with its last one.)
import type { QueryClient } from "@tanstack/react-query";
import type {
  SharedSettingEntry,
  SharedSettingsDoc,
  SharedSettingValue,
} from "@shared/schemas";
import {
  exchangeSharedSettings,
  mergeSharedSettings,
  sharedSettingKeys,
} from "@shared/sharedSettings";
import { clientConfigQueryOptions } from "@/hooks/config/useClientConfig";
import { mergeClientConfigWrite } from "@/hooks/config/mergeClientConfigWrite";
import { queryKeys } from "@/lib/queryKeys";
import { deviceStatusView } from "./deviceStatus";
import { remoteDeviceStore } from "./devices";
import { apiFor, onSessionLanded } from "./remoteDeviceSync";

// Offers entries to every peer in reach. Best-effort by design (see the
// header): a peer with no grant, an older build with no such channel
// and a session that just dropped all refuse, and each is caught up by
// a pull instead.
function offerToPeers(doc: SharedSettingsDoc): void {
  if (Object.keys(doc.entries).length === 0) return;
  for (const device of remoteDeviceStore.getSnapshot()) {
    if (!deviceStatusView(device.status).reachable) continue;
    device.api?.sharedSettings.merge(doc).catch(() => undefined);
  }
}

// The write path for every shared setting: the local copy first, so
// the pick holds here whatever the network is doing, then an offer to
// each peer with a session.
export async function writeSharedSetting(
  key: string,
  value: SharedSettingValue,
): Promise<SharedSettingsDoc> {
  const doc = await window.api.sharedSettings.set(key, value);
  const entry = doc.entries[key];
  if (entry !== undefined) offerToPeers({ entries: { [key]: entry } });
  return doc;
}

// A peer's copy moved (remoteHostWatch routes its push here, already
// parsed): fold it into the local copy. Unconditional on purpose. The
// host settles an echo cheaply, and asking it every time is what lets a
// local copy that was reset behind the window fill back in.
export function mergePeerSharedSettings(doc: SharedSettingsDoc): void {
  window.api.sharedSettings.merge(doc).catch(() => undefined);
}

// The one writer of the cached local copy. Merged in rather than set,
// so a late arrival can never roll the cache back: the seeding read
// resolving after a broadcast, or two broadcasts landing out of order,
// both merge to nothing. The one exception is an EMPTY copy, which
// only a clear announces (a device leaving its account): that is a
// roll-back on purpose, and a merge would learn nothing from it.
function noteLocalCopy(queryClient: QueryClient, doc: SharedSettingsDoc): void {
  const key = queryKeys.sharedSettings();
  void queryClient.cancelQueries({ queryKey: key, exact: true });
  const cleared = Object.keys(doc.entries).length === 0;
  queryClient.setQueryData<SharedSettingsDoc>(key, (held) =>
    held === undefined || cleared ? doc : mergeSharedSettings(held, doc),
  );
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
  const entries: Record<string, SharedSettingEntry> = {};
  for (const [identity, deviceId] of Object.entries(legacy)) {
    entries[sharedSettingKeys.quickCreateDevice(identity)] = {
      value: deviceId,
      at: 0,
      by: window.api.deviceId,
    };
  }
  await window.api.sharedSettings.merge({ entries });
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
  // The local copy rides its broadcast whole, so the cache is written
  // rather than re-asked, and useSharedSettings never refetches.
  window.api.sharedSettings.onChanged((doc) => {
    noteLocalCopy(queryClient, doc);
  });
  onSessionLanded((deviceId) => {
    exchangeSharedSettings(
      window.api.sharedSettings,
      apiFor(deviceId).sharedSettings,
    ).catch(() => undefined);
  });
  migrateQuickCreateDevices(queryClient).catch((error: unknown) => {
    console.warn("[sharedSettings] create-device migration failed", error);
  });
}
