import { GUIDE_HARNESS_LABELS } from "@shigomori/contracts/modules/guide";
import { GuideBandView } from "@shigomori/ui/views/guide/GuideView.tsx";
import { useGuide } from "@/hooks/useGuide";
import { notifyError } from "@/lib/toast";

// The band over the page while a guide drives this window.
export function GuideBand() {
  const guide = useGuide();
  if (guide === null) return null;
  return (
    <GuideBandView
      harnessLabel={GUIDE_HARNESS_LABELS[guide.harness]}
      onStop={() =>
        void window.api.guide
          .stop()
          .catch((error: unknown) =>
            notifyError("Couldn't stop the guide", error),
          )
      }
    />
  );
}
