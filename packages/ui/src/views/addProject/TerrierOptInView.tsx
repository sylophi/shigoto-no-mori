import { useRef } from "react";
import { Checkbox } from "../../primitives/checkbox.tsx";

// The add-project dialog's box: the project goes into terrier too. A
// click on it (or on its label, which focuses the box) hands focus back
// to what had it, so the keys that submit still reach the form.
export function TerrierOptInView({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const focusedBefore = useRef<HTMLElement | null>(null);
  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- it only notes where focus was, the label still toggles the box
    <label
      onPointerDown={() => {
        focusedBefore.current =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
      }}
      className="-mx-1 flex shrink-0 cursor-pointer items-center gap-2 rounded-md px-1 text-xs text-muted-foreground select-none hover:bg-accent"
    >
      <Checkbox
        checked={checked}
        onCheckedChange={(next) => {
          onCheckedChange(next);
          focusedBefore.current?.focus();
          focusedBefore.current = null;
        }}
      />
      Add to terrier
    </label>
  );
}
