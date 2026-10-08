import type { ReactNode, RefObject } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { useOffersTerrier } from "@/hooks/terrier/useOffersTerrier";

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
      <TerrierOptIn
        checked={addToTerrier}
        onCheckedChange={(next) => {
          setAddToTerrier(next);
          inputRef.current?.focus();
        }}
      />
    ),
  };
}

function TerrierOptIn({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="-mx-1 flex shrink-0 cursor-pointer items-center gap-2 rounded-md px-1 text-xs text-muted-foreground select-none hover:bg-muted dark:hover:bg-muted/50">
      <Checkbox checked={checked} onCheckedChange={onCheckedChange} />
      Add to terrier
    </label>
  );
}
