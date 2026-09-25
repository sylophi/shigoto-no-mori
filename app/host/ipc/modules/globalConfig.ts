import { globalConfigContract } from "@shared/ipc/modules/globalConfig";
import type { Handlers } from "@shared/ipc/types";
import type { DeviceSettingsPatch } from "@shared/schemas";
import {
  invalidateGlobalConfigCache,
  readGlobalConfig,
  readGlobalConfigFresh,
  redactGlobalConfigForRead,
  withGlobalConfigWriteLock,
} from "@host/lib/config/global";
import { invalidateTerrierCaches } from "@host/lib/terrier";
import { globalConfigWriteViaCli } from "../cliDelegate";

export const globalConfigHandlers: Handlers<typeof globalConfigContract> = {
  // Redact before returning: socketHost.token is a secret and must be
  // absent from the read on either wire. Redaction happens here (not
  // only in the output schema) because packaged builds skip output
  // re-parsing.
  read: async () => redactGlobalConfigForRead(await readGlobalConfig()),
  // Local unredacted read. Returns the full stored document with no
  // redaction, so the renderer can reconcile its remote-device registry
  // and read a whole-document write base that keeps remoteDevices and
  // socketHost.token. The contract tags this remote false, so it is
  // never bound to the socket and a peer can never reach it.
  readLocal: async () => readGlobalConfig(),
  // Same engine rule as the worktree/project mutations: the CLI
  // performs the write.
  write: async ({ config }) =>
    // Under the shared config write lock so a local whole-document write
    // and a remote writeDeviceSettings patch mutually exclude on the host.
    withGlobalConfigWriteLock(async () => {
      await globalConfigWriteViaCli(config);
      // The watcher treats the delegated spawn as a self-write, so the
      // TTL cache must be dropped here rather than by the fs event. This
      // fans out to the config-change subscribers too, so the socket
      // listener reconciles with the just-written document. No separate
      // refresh hook is needed: every config-change path reconciles
      // through invalidateGlobalConfigCache now.
      invalidateGlobalConfigCache();
      // The terrier merge gates on the toggle just written. Without this
      // the sidebar would keep the pre-save project list for a TTL.
      invalidateTerrierCaches();
    }),
  // The remote-writable device-settings subset. The zod boundary already
  // rejected any key outside the managed set (the patch schema is
  // strict), so by the time this runs the patch can only carry settings
  // the Settings form manages, never socketHost or remoteDevices.
  // Patch semantics: read the UNREDACTED local document as the base,
  // spread only the provided keys over it, and write the whole document
  // through the same CLI path as `write` above, mirroring its
  // cache-invalidation so listener reconciliation still runs. An
  // explicitly-undefined key is skipped rather than spread, or the
  // whole-document write would delete the base's value for it.
  writeDeviceSettings: async ({ patch }) =>
    // Under the shared config write lock so this whole read-modify-write
    // cannot interleave with a concurrent local `write` and lose an
    // update. Both host write handlers acquire the same lock.
    withGlobalConfigWriteLock(async () => {
      // Cache-bypassing base: a base up to the 5s TTL stale would let this
      // whole-document write resurrect a just-rotated socketHost.token or
      // re-enable a just-disabled host, because the CLI clears every
      // registered key the payload omits. The fresh read is what makes the
      // base authoritative for those registered keys.
      const base = await readGlobalConfigFresh();
      const provided = Object.fromEntries(
        Object.entries(patch).filter(([, value]) => value !== undefined),
      ) as DeviceSettingsPatch;
      await globalConfigWriteViaCli({ ...base, ...provided });
      invalidateGlobalConfigCache();
      // Device-settings patches can carry the terrier toggle too, so the
      // merged project list must not serve a pre-save TTL entry either.
      invalidateTerrierCaches();
    }),
};
