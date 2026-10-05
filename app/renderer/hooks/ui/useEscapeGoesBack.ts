import { useEffect } from "react";
import { isBareKeyEvent } from "@/lib/dom";

// Escape presses the back button. A page's own comes last in the
// document, after the ones the window keeps (the sidebar's way back to
// the projects, the phone header's), so it is the one Escape takes
// where there is one, and the window's where there isn't.
// isBareKeyEvent keeps it out of text fields, the terminal and any open
// menu or dialog, which spend Escape on themselves. A page holding
// unsaved changes (EditorFooter's data-hold-escape) keeps it too: a
// slip of the key would drop the draft, and the button is still there
// for a deliberate exit.
export function useEscapeGoesBack(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || !isBareKeyEvent(e)) {
        return;
      }
      if (all("[data-hold-escape]").some(visible)) return;
      const back = all("[data-back-button]").findLast(visible);
      if (!back) return;
      e.preventDefault();
      back.click();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

const all = (selector: string) => [
  ...document.querySelectorAll<HTMLElement>(selector),
];
const visible = (el: HTMLElement) => el.checkVisibility();
