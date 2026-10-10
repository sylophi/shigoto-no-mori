import type { ReactNode, RefObject } from "react";
import { useOffersTerrier } from "@/hooks/terrier/useOffersTerrier";
import { TerrierOptInView } from "./TerrierOptInView";

// Whether a project added here goes into terrier too, and the footer's
// box that says so. Asked only of a device that lists terrier's repos.
// The choice itself is the dialog's, so it outlives a change of mode or
// device. Ticking the box hands focus back to the view's input (a click
// on its label focuses the box), so ↩ still submits.
export function useTerrierOptIn(
  addToTerrier: boolean,
  setAddToTerrier: (value: boolean) => void,
  inputRef: RefObject<HTMLInputElement | null>,
): { terrier: boolean; terrierOptIn: ReactNode } {
  const offered = useOffersTerrier();
  return {
    terrier: offered && addToTerrier,
    terrierOptIn: offered && (
      <TerrierOptInView
        checked={addToTerrier}
        onCheckedChange={(next) => {
          setAddToTerrier(next);
          inputRef.current?.focus();
        }}
      />
    ),
  };
}
