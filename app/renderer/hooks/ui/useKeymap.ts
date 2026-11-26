// This window's keymap: the table in @shigomori/ui's lib/keymap.ts
// under the device's bindings, and the one listener that runs an action
// when its keys are pressed. A component says what an action does with
// useKeymapAction while it is on screen, and shows its keys with
// useBinding. The menu's actions are the shell's: their keys go to its
// menu (useMenuChords), which runs them.
import { useEffect, useEffectEvent, useState } from "react";
import {
  createExternalStore,
  useExternalStore,
} from "@shigomori/ui/lib/externalStore.ts";
import {
  type Binding,
  type HeldModifiers,
  KEYMAP_ACTIONS,
  NO_MODIFIERS,
  menuAccelerators,
  resolveKeymap,
  sameModifiers,
} from "@shigomori/ui/lib/keymap.ts";
import { isMac, viewerOs } from "@shigomori/ui/lib/platform.ts";
import { useClientConfig } from "@/hooks/config/useClientConfig";
import { onWindowFocus } from "@/lib/focus";
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

const MENU_ACTIONS = KEYMAP_ACTIONS.filter((action) => action.menu).map(
  (action) => action.id,
);

// On Windows, a Ctrl chord no shell is sent, as Windows Terminal keeps
// its own: Ctrl+Shift on a letter, or Ctrl on a digit or a comma. Every
// other Ctrl chord (Ctrl+C, D, W, R, K, N...) is the shell's.
const pastShell = (e: KeyboardEvent): boolean =>
  viewerOs === "windows" &&
  e.ctrlKey &&
  !e.altKey &&
  ((e.shiftKey && /^Key[A-Z]$/.test(e.code)) ||
    /^(Digit\d|Comma)$/.test(e.code));

const CTRL_TWIN_ACTIONS = new Set(
  KEYMAP_ACTIONS.filter((action) => action.ctrlTwin).map((action) => action.id),
);

// The window's listener, mounted once (AppShell). A text field keeps
// every key but a `Mod` chord and its Ctrl twin, which the action may
// still leave to the field (Enter's, arrows' and the editing keys'
// meanings are the field's), and a focused terminal every key a shell
// can be sent: it gives up a ⌘ chord bound here, on Windows a chord no
// shell is sent (pastShell), and the terminal's own toggle. Those are
// claimed in the capture phase, before the terminal sees them. The rest
// wait for the bubble, so a control that spent the key (an editor's
// Escape) keeps it.
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
      const app = pastShell(e);
      const found = pressedActions(keymap, e).filter(
        ({ id }) => TERMINAL_ACTIONS.has(id) || (isMac && e.metaKey) || app,
      );
      if (run(e, found)) e.stopPropagation();
      // Kept from the terminal and left to the menu, which runs it.
      else if (app && MENU_ACTIONS.some((id) => keymap.get(id)?.matches(e))) {
        e.stopPropagation();
      }
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
    const chords = paused ? {} : menuAccelerators(keymap);
    void api.run(api.menu.setChords({ chords }));
  }, [keymap, paused, api, hasLocalHost]);
}

const modifiersOf = (e: KeyboardEvent): HeldModifiers => ({
  meta: e.metaKey,
  ctrl: e.ctrlKey,
  alt: e.altKey,
  shift: e.shiftKey,
});

const MODIFIER_KEYS = new Set(["Meta", "Control", "Alt", "Shift"]);

// How long modifiers stay down alone before they count as held, so a
// chord typed straight through (⌘C) doesn't flash them.
const HOLD_MS = 400;

// Which modifier keys are held down alone in this window while
// `enabled`. Cleared when the window loses focus because a launched app
// or app switch takes it before the keyup arrives.
export function useHeldModifiers(enabled: boolean): HeldModifiers {
  const [held, setHeld] = useState<HeldModifiers>(NO_MODIFIERS);

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = (e: KeyboardEvent) => {
      if (e.repeat) return;
      clearTimeout(timer);
      setHeld(NO_MODIFIERS);
      if (!MODIFIER_KEYS.has(e.key)) return;
      const next = modifiersOf(e);
      if (!sameModifiers(next, NO_MODIFIERS)) {
        timer = setTimeout(() => setHeld(next), HOLD_MS);
      }
    };
    window.addEventListener("keydown", update, true);
    window.addEventListener("keyup", update, true);
    const stopFollowingFocus = onWindowFocus((focused) => {
      if (focused) return;
      clearTimeout(timer);
      setHeld(NO_MODIFIERS);
    });
    return () => {
      window.removeEventListener("keydown", update, true);
      window.removeEventListener("keyup", update, true);
      stopFollowingFocus();
      clearTimeout(timer);
      setHeld(NO_MODIFIERS);
    };
  }, [enabled]);

  return held;
}
