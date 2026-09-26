import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import acNotice from "@shared/acNotice.json";

// Shown on hover beside the settings that bring Animal Crossing along
// (Doubutsu names, Village life). The name pool's entry in the bundled
// third-party licenses opens with the same text.
const AC_NOTICE = acNotice.notice;

// A setting's label with the notice's info icon after it.
export function AcNoticeLabel({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {children}
      {/* A button, so the icon is focusable and a click on it
          (preventDefault) doesn't flip the row's switch. */}
      <SimpleTooltip tip={AC_NOTICE}>
        <button
          type="button"
          aria-label={AC_NOTICE}
          onClick={(e) => e.preventDefault()}
          className="inline-flex cursor-help rounded-sm text-muted-foreground hover:text-foreground"
        >
          <Info aria-hidden className="size-3.5" />
        </button>
      </SimpleTooltip>
    </span>
  );
}
