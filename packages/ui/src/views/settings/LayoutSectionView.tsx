import { RotateCcw } from "lucide-react";
import { Button } from "../../primitives/button.tsx";
import { SectionIntro } from "../../primitives/section-heading.tsx";

// The sizes the user dragged, put back to their defaults at once.
export function LayoutSectionView({ onReset }: { onReset: () => void }) {
  return (
    <section>
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
    </section>
  );
}
