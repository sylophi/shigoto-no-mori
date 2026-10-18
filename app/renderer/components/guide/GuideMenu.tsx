import { useEffect, useEffectEvent } from "react";
import { navContract } from "@shigomori/contracts/modules/nav";
import { startGuide, useGuideHarnesses } from "@/hooks/useGuide";
import { useApi } from "@/lib/runtime/pageApi";

// The Help menu's guides: this device's harnesses go to the menu, and
// an item opens its harness guiding this window.
export function GuideMenu() {
  const api = useApi();
  const harnesses = useGuideHarnesses();
  // Once per list: `harnesses` is a fresh array per render.
  const shown = harnesses?.join(",");
  const tellMenu = useEffectEvent(() => {
    if (harnesses === undefined) return;
    // A menu that didn't take it keeps the last list it had, which the
    // next one replaces.
    void api.run(api.menu.setGuideHarnesses(harnesses)).catch(() => {});
  });
  useEffect(() => tellMenu(), [api, shown]);
  useEffect(
    () =>
      api.listen(api.pushes(navContract, "showAround"), (harness) =>
        startGuide(api, harness),
      ),
    [api],
  );
  return null;
}
