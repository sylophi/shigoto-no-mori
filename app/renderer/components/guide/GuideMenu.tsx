import { useEffect, useEffectEvent } from "react";
import { guideChoicesKey } from "@shigomori/contracts/modules/guide";
import { navContract } from "@shigomori/contracts/modules/nav";
import { startGuide, useGuideChoices } from "@/hooks/useGuide";
import { useApi } from "@/lib/runtime/pageApi";

// The Help menu's guides: this device's choices go to the menu, and an
// item opens its harness guiding this window.
export function GuideMenu() {
  const api = useApi();
  const choices = useGuideChoices();
  // Once per list: `choices` is a fresh object per render.
  const shown = choices === undefined ? undefined : guideChoicesKey(choices);
  const tellMenu = useEffectEvent(() => {
    if (choices === undefined) return;
    // A menu that didn't take it keeps the last list it had, which the
    // next one replaces.
    void api.run(api.menu.setGuideChoices(choices)).catch(() => {});
  });
  useEffect(() => tellMenu(), [api, shown]);
  useEffect(
    () =>
      api.listen(api.pushes(navContract, "showAround"), (start) =>
        startGuide(api, start),
      ),
    [api],
  );
  return null;
}
