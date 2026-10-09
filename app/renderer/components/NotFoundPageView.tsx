// Catch-all for unknown paths (a browser tab can land on one through
// its address bar): never a white screen, always a way back.
import { Button } from "@/components/ui/button";
import { CenteredMessage } from "@/components/ui/centered-message";

export function NotFoundPageView({ onHome }: { onHome: () => void }) {
  return (
    <CenteredMessage>
      <div className="flex flex-col items-center gap-3">
        <span>There is nothing at this address.</span>
        <Button variant="outline" onClick={onHome}>
          Go home
        </Button>
      </div>
    </CenteredMessage>
  );
}
