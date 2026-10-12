import { useEffect } from "react";
import { navContract } from "@shigomori/contracts/modules/nav";
import { useGuideHarnesses } from "@/hooks/useGuide";
import { notifyError } from "@/lib/toast";
import { useApi } from "@/lib/runtime/pageApi";

// The Help menu's guides: this device's harnesses go to the menu, and
// an item opens its harness guiding this window.
export function GuideMenu() {
  const api = useApi();
  const harnesses = useGuideHarnesses();
  const shown = harnesses?.join(",");
  useEffect(() => {
    if (harnesses !== undefined) {
      void api.run(api.menu.setGuideHarnesses(harnesses));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per list: `harnesses` is a fresh array per render.
  }, [api, shown]);
  useEffect(
    () =>
      api.listen(api.pushes(navContract, "showAround"), (harness) => {
        void api
          .run(api.guide.start({ harness }))
          .catch((error: unknown) =>
            notifyError("Couldn't open the guide", error),
          );
      }),
    [api],
  );
  return null;
}
