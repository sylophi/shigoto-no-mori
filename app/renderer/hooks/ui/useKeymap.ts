// This window's keymap: the table in @shigomori/ui's lib/keymap.ts
// under the device's bindings, and the one listener that runs an action
// when its keys are pressed. A component says what an action does with
// useKeymapAction while it is on screen, and shows its keys with
// useBinding. The menu's actions are the shell's: their keys go to its
// menu (useMenuChords), which runs them.
import { useEffect, useEffectEvent } from "react";
import {
  createExternalStore,
  useExternalStore,
} from "@shigomori/ui/lib/externalStore.ts";
import {
  type Binding,
  chordAccelerator,
  KEYMAP_ACTIONS,
  resolveKeymap,
} from "@shigomori/ui/lib/keymap.ts";
import { isMac } from "@shigomori/ui/lib/platform.ts";
import { useClientConfig } from "@/hooks/config/useClientConfig";
import { isEditableTarget, isOverlayOpen, isRawKeySurface } from "@/lib/dom";
import { useHasLocalHost } from "@/lib/localHost";
import { useApi } from "@/lib/runtime/pageApi";

// `stored` (the client config's keybindings, or a form's) over the
// defaults, for this window.
export const keymapOf = (
  stored: Readonly<Record<string, string>> | undefined,
  desktop: boolean,
) => resolveKeymap(stored, { mac: isMac, desktop });

export function useKeymap(): ReadonlyMap<string, Binding> {
  return keymapOf(useClientConfig().data?.keybindings, useHasLocalHost());
}

// While Settings records an action's keys, nothing else hears them:
// the listener stands aside and the menu holds no keys.
const recording = createExternalStore(false);

export function useKeymapRecording(on: boolean): void {
  useEffect(() => {
    if (!on) return;
    recording.publish(true);
    return () => recording.publish(false);
  }, [on]);
}

// An action's keys here. Every window has every action but the menu's,
// which a web client lacks: those are read off useKeymap.
export function useBinding(id: string): Binding {
  const binding = useKeymap().get(id);
  if (!binding) throw new Error(`No action ${id} in this window's keymap`);
  return binding;
}

type Handler = {
  // False when the press is not for it after all, which leaves the key
  // to whatever else hears it.
  readonly run: (e: KeyboardEvent) => boolean | void;
  // Whether it acts while a dialog or a menu is open over the page.
  readonly overOverlays: boolean;
};

// What each action does, as the components on screen say: the last to
// mount wins, and an unmount hands it back.
const handlers = new Map<string, Handler[]>();

// What `id` does while the caller is on screen and `enabled`.
export function useKeymapAction(
  id: string,
  run: (e: KeyboardEvent) => boolean | void,
  { enabled = true, overOverlays = false } = {},
): void {
  // The latest closure, so a render does not re-register.
  const latest = useEffectEvent(run);
  useEffect(() => {
    if (!enabled) return;
    const handler: Handler = {
      run: (e) => latest(e),
      overOverlays,
    };
    handlers.set(id, [...(handlers.get(id) ?? []), handler]);
    return () => {
      const left = (handlers.get(id) ?? []).filter((h) => h !== handler);
      if (left.length > 0) handlers.set(id, left);
      else handlers.delete(id);
    };
  }, [id, enabled, overOverlays]);
}

// The actions whose keys `e` presses, with what they do.
function pressedActions(
  keymap: ReadonlyMap<string, Binding>,
  e: KeyboardEvent,
): { id: string; handler: Handler }[] {
  const found: { id: string; handler: Handler }[] = [];
  for (const [id, binding] of keymap) {
    const handler = handlers.get(id)?.at(-1);
    if (handler && binding.matches(e)) found.push({ id, handler });
  }
  return found;
}

const TERMINAL_ACTIONS = new Set(
  KEYMAP_ACTIONS.filter((action) => action.terminal).map((action) => action.id),
);

const CTRL_TWIN_ACTIONS = new Set(
  KEYMAP_ACTIONS.filter((action) => action.ctrlTwin).map((action) => action.id),
);

// The window's listener, mounted once (AppShell). A text field keeps
// every key but a `Mod` chord and its Ctrl twin, which the action may
// still leave to the field (Enter's, arrows' and the editing keys'
// meanings are the field's), and a focused terminal every key a shell
// can be sent: it gives up a ⌘ chord bound here and the terminal's own
// toggle. Those two are claimed in the capture phase,
// before the terminal sees them; the rest wait for the bubble, so a
// control that spent the key (an editor's Escape) keeps it.
export function useKeymapListener(): void {
  const keymap = useKeymap();
  const paused = useExternalStore(recording);
  useEffect(() => {
    if (paused) return;
    const run = (
      e: KeyboardEvent,
      found: { id: string; handler: Handler }[],
    ) => {
      const overlay = isOverlayOpen();
      for (const { handler } of found) {
        if (overlay && !handler.overOverlays) continue;
        if (handler.run(e) === false) continue;
        e.preventDefault();
        return true;
      }
      return false;
    };
    const fromTerminal = (e: KeyboardEvent) => {
      if (e.repeat || e.isComposing || !isRawKeySurface(e.target)) return;
      const found = pressedActions(keymap, e).filter(
        ({ id }) => TERMINAL_ACTIONS.has(id) || (isMac && e.metaKey),
      );
      if (run(e, found)) e.stopPropagation();
    };
    const fromPage = (e: KeyboardEvent) => {
      if (e.repeat || e.isComposing || e.defaultPrevented) return;
      if (isRawKeySurface(e.target)) return;
      const mod = isMac ? e.metaKey : e.ctrlKey;
      const found = pressedActions(keymap, e).filter(
        ({ id }) =>
          mod ||
          TERMINAL_ACTIONS.has(id) ||
          (isMac && e.ctrlKey && CTRL_TWIN_ACTIONS.has(id)) ||
          !isEditableTarget(e.target),
      );
      run(e, found);
    };
    window.addEventListener("keydown", fromTerminal, true);
    window.addEventListener("keydown", fromPage);
    return () => {
      window.removeEventListener("keydown", fromTerminal, true);
      window.removeEventListener("keydown", fromPage);
    };
  }, [keymap, paused]);
  useMenuChords(keymap, paused);
}

// The menu's actions' keys, handed to the shell's menu, which shows the
// focused window's.
function useMenuChords(
  keymap: ReadonlyMap<string, Binding>,
  paused: boolean,
): void {
  const api = useApi();
  const hasLocalHost = useHasLocalHost();
  useEffect(() => {
    if (!hasLocalHost) return;
    const chords: Record<string, string> = {};
    for (const action of paused ? [] : KEYMAP_ACTIONS) {
      const binding = keymap.get(action.id);
      if (action.menu && binding) {
        chords[action.id] = chordAccelerator(binding.chord);
      }
    }
    void api.run(api.menu.setChords({ chords }));
  }, [keymap, paused, api, hasLocalHost]);
}
