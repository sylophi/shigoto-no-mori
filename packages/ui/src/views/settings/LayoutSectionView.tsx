import { RotateCcw } from "lucide-react";
import { Button } from "../../primitives/button.tsx";
import { SectionIntro } from "../../primitives/section-heading.tsx";
import { ToggleRowView } from "../shared/ToggleRowView.tsx";

// The sizes the user dragged, put back to their defaults at once, and
// on the desktop whether terminals at the side widen the window.
export function LayoutSectionView({
  onReset,
  widenForSideTerminals,
}: {
  onReset: () => void;
  widenForSideTerminals?: {
    readonly checked: boolean;
    readonly onCheckedChange: (next: boolean) => void;
  };
}) {
  return (
    <section className="space-y-3">
      <SectionIntro
        title="Layout"
        action={
          <Button variant="ghost" size="sm" onClick={onReset}>
            <RotateCcw />
            Reset layout
          </Button>
        }
      >
        The sidebar and the terminals keep the sizes you drag them to.
      </SectionIntro>
      {widenForSideTerminals && (
        <ToggleRowView
          {...widenForSideTerminals}
          label="Widen the window for terminals at the side"
        />
      )}
    </section>
  );
}
