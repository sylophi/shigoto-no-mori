// The shared settings as this device holds them: one document, the
// same on every device once they have talked
// (lib/remote/sharedSettingsSync.ts keeps it level and owns the write
// path), as the local copy streams it (sharedSettings:watch): this
// machine's host's, or in the web client the tab's own.
import { useAtomValue } from "@effect/atom-react";
import { useMutation } from "@tanstack/react-query";
import { useRef } from "react";
import { callOf } from "@shigomori/contracts/contract";
import { sharedSettingsContract } from "@shigomori/contracts/modules/sharedSettings";
import type {
  SharedSettingsDoc,
  SharedSettingValue,
} from "@shigomori/contracts/schemas";
import { sharedStringSetting } from "@shigomori/contracts/sharedSettings";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { localDeviceId } from "@/lib/queryKeys";
import { writeSharedSetting } from "@/lib/remote/sharedSettingsSync";
import { hostViewAtom } from "@/lib/runtime/atoms";

const sharedSettingsAtom = hostViewAtom({
  deviceId: localDeviceId,
  localDeviceId,
  view: callOf(sharedSettingsContract, "watch"),
  input: undefined,
});

const docOf = (
  result: AsyncResult.AsyncResult<SharedSettingsDoc, unknown>,
): SharedSettingsDoc | undefined =>
  AsyncResult.isSuccess(result) ? result.value : undefined;

// One string setting out of the document (undefined key: no setting to
// read). Selected, so an observer re-renders when its own setting moves
// and not on every pick made anywhere: the sidebar holds one of these
// per project row, and the document moves on peer traffic.
export function useSharedStringSetting(
  key: string | undefined,
): string | undefined {
  return useAtomValue(sharedSettingsAtom, (result) => {
    const doc = docOf(result);
    return doc === undefined || key === undefined
      ? undefined
      : sharedStringSetting(doc, key);
  });
}

// A reading over the whole document, for a setting spread over many
// keys. Selected like the one above, and a reading equal to the last
// (a sorted list read again) is handed back as the last one, so an
// observer re-renders only when it moved.
export function useSharedSettingsView<T>(
  select: (doc: SharedSettingsDoc) => T,
): T | undefined {
  const last = useRef<{ json: string; value: T } | null>(null);
  return useAtomValue(sharedSettingsAtom, (result) => {
    const doc = docOf(result);
    if (doc === undefined) return undefined;
    const value = select(doc);
    const json = JSON.stringify(value);
    if (last.current?.json === json) return last.current.value;
    last.current = { json, value };
    return value;
  });
}

// Whether the local copy has been read (or the read has failed, which
// leaves nothing to wait for). Until then an unset setting and an
// unread one look alike, and a surface that acts on the difference
// holds off.
export function useSharedSettingsSettled(): boolean {
  return useAtomValue(
    sharedSettingsAtom,
    (result) => !AsyncResult.isInitial(result),
  );
}

// The writer for one key (undefined: nothing to write to, a no-op).
// Applies right away, and the local copy's view follows it.
export function useSetSharedSetting(
  key: string | undefined,
  errorTitle: string,
) {
  const mutation = useMutation({
    mutationFn: (write: { key: string; value: SharedSettingValue }) =>
      writeSharedSetting(write.key, write.value),
    meta: { errorTitle },
  });
  return (value: SharedSettingValue) => {
    if (key !== undefined) mutation.mutate({ key, value });
  };
}
