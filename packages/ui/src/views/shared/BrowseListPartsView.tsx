// The footer's key hints shared by the folder browsers (PathBrowserView)
// and the filter-first picker (PathPickerView).
import { ArrowLeft } from "lucide-react";
import { KbdHint } from "../../primitives/kbd.tsx";

// ↩ into the highlighted folder, and ← up out of this one. The arrows
// go without saying.
export function BrowseKeyHintsView({
  enterFolder,
  goUp,
}: {
  enterFolder: boolean;
  goUp: boolean;
}) {
  return (
    <>
      {enterFolder && <KbdHint keys={["↩"]} label="Enter folder" />}
      {goUp && <KbdHint keys={[<ArrowLeft key="left" />]} label="Go up" />}
    </>
  );
}
