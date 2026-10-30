// ⌘W, which the desktop's menu takes before the page sees it: the menu
// closes the window, or asks it to close the tab of the terminal that
// holds its focus, which the window tells it of.
import { useEffect, useEffectEvent } from "react";
import { navContract } from "@shigomori/contracts/modules/nav";
import { isRawKeySurface } from "@/lib/dom";
import { useApi } from "@/lib/runtime/pageApi";

// How the terminal tabs on screen close their picked one.
let closeTab: (() => void) | null = null;

export function useCloseKeyClosesTab(close: () => void): void {
  const latest = useEffectEvent(close);
  useEffect(() => {
    const own = () => latest();
    closeTab = own;
    return () => {
      if (closeTab === own) closeTab = null;
    };
  }, []);
}

export function useCloseKey(): void {
  const api = useApi();
  useEffect(() => {
    if (!api.isElectron) return;
    let focused = false;
    const report = (target: EventTarget | null) => {
      if (isRawKeySurface(target) === focused) return;
      focused = !focused;
      void api.run(api.menu.setTerminalFocused(focused));
    };
    const onFocusIn = (e: FocusEvent) => report(e.target);
    const onFocusOut = (e: FocusEvent) => report(e.relatedTarget);
    window.addEventListener("focusin", onFocusIn);
    window.addEventListener("focusout", onFocusOut);
    // The menu's word can be stale by the time it lands (the terminal
    // gone as its tab closed), and the window is what it closes then.
    const stop = api.listen(api.pushes(navContract, "closeTab"), () => {
      if (closeTab && isRawKeySurface(document.activeElement)) closeTab();
      else window.close();
    });
    return () => {
      window.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("focusout", onFocusOut);
      stop();
    };
  }, [api]);
}
