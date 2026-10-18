// The shared settings as this device holds them: one document, the
// same on every device once they have talked
// (lib/remote/sharedSettingsSync.ts keeps it level and owns the write
// path), as the local copy streams it (sharedSettings:watch): this
// machine's host's, or in the web client the tab's own.
import { useAtomValue } from "@effect/atom-react";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import * as Cause from "effect/Cause";
import { notifyError } from "@/lib/toast";
import { callOf } from "@shigomori/contracts/contract";
import { sharedSettingsContract } from "@shigomori/contracts/modules/sharedSettings";
import type {
  SharedSettingsDoc,
  SharedSettingValue,
} from "@shigomori/contracts/schemas";
import { sharedStringSetting } from "@shigomori/contracts/sharedSettings";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { writeSharedSetting } from "@/lib/remote/sharedSettingsSync";
import { hostViewAtom } from "@/lib/runtime/atoms";
import { useApi } from "@/lib/runtime/pageApi";
import { useRegistry } from "@/lib/runtime/viewHooks";

const sharedSettingsAtom = Atom.family((deviceId: string) =>
  hostViewAtom({
    deviceId,
    view: callOf(sharedSettingsContract, "watch"),
    input: undefined,
  }),
);

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
  return useAtomValue(sharedSettingsAtom(useApi().deviceId), (result) => {
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
  return useAtomValue(sharedSettingsAtom(useApi().deviceId), (result) => {
    const doc = docOf(result);
    if (doc === undefined) return undefined;
    const value = select(doc);
    const json = JSON.stringify(value);
    if (last.current?.json === json) return last.current.value;
    last.current = { json, value };
    return value;
  });
}

// Whether the local copy has been read. Until then an unset setting and
// an unread one look alike, and a surface that acts on the difference
// holds off; a read that failed says so and keeps it off, since a write
// over a document never read would replace what is stored.
export function useSharedSettingsSettled(): boolean {
  const result = useAtomValue(sharedSettingsAtom(useApi().deviceId));
  const failure = AsyncResult.isFailure(result)
    ? Cause.squash(result.cause)
    : null;
  useEffect(() => {
    if (failure !== null) {
      notifyError("Couldn't load shared settings", failure);
    }
  }, [failure]);
  return AsyncResult.isSuccess(result);
}

// The writer for one key (undefined: nothing to write to, a no-op).
// Applies right away, and the local copy's view follows it.
export function useSetSharedSetting(
  key: string | undefined,
  errorTitle: string,
) {
  const api = useApi();
  const registry = useRegistry();
  const mutation = useMutation({
    mutationFn: (write: { key: string; value: SharedSettingValue }) =>
      writeSharedSetting(api, registry, write.key, write.value),
    meta: { errorTitle },
  });
  // `onFailed` lets a caller take back what it showed ahead of the
  // write.
  return (value: SharedSettingValue, onFailed?: () => void) => {
    if (key !== undefined) {
      mutation.mutate({ key, value }, { onError: () => onFailed?.() });
    }
  };
}
