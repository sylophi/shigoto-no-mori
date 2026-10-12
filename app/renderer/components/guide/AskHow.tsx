import { useEffect, useState } from "react";
import { ModalShell } from "@shigomori/ui/primitives/modal-shell.tsx";
import { AskHowDialogView } from "@shigomori/ui/views/guide/GuideView.tsx";
import type { GuideHarness } from "@shigomori/contracts/modules/guide";
import { navContract } from "@shigomori/contracts/modules/nav";
import { useGuideHarnesses } from "@/hooks/useGuide";
import { isOverlayOpen } from "@/lib/dom";
import { notifyError } from "@/lib/toast";
import { useApi } from "@/lib/runtime/pageApi";

// Help → Ask How…: a dialog for the question, over the page unless
// another overlay is up.
export function AskHow() {
  const api = useApi();
  const [open, setOpen] = useState(false);
  useEffect(
    () =>
      api.listen(api.pushes(navContract, "askHow"), () => {
        if (!isOverlayOpen()) setOpen(true);
      }),
    [api],
  );
  return open && <AskHowDialog onClose={() => setOpen(false)} />;
}

// Up until the agent's terminal opens. A failure toasts and leaves the
// dialog up to try again.
function AskHowDialog({ onClose }: { onClose: () => void }) {
  const api = useApi();
  const harnesses = useGuideHarnesses();
  const [question, setQuestion] = useState("");
  const [picked, setPicked] = useState<GuideHarness | null>(null);
  const [asking, setAsking] = useState<GuideHarness | null>(null);
  const ask = (harness: GuideHarness) => {
    setAsking(harness);
    void api
      .run(api.guide.ask({ harness, question: question.trim() }))
      .then(onClose, (error: unknown) => {
        setAsking(null);
        notifyError("Couldn't open the guide", error);
      });
  };
  return (
    <ModalShell
      label="Ask how"
      onClose={() => {
        if (asking === null) onClose();
      }}
      popoverClassName="max-w-md"
    >
      <AskHowDialogView
        question={question}
        onQuestionChange={setQuestion}
        harnesses={harnesses}
        harness={picked}
        onHarnessChange={setPicked}
        asking={asking}
        onAsk={ask}
        onCancel={onClose}
      />
    </ModalShell>
  );
}
