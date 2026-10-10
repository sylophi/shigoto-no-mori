import { Button } from "./button.tsx";
import { EmptyPanel } from "./empty-panel.tsx";

// A read that failed, in place of the body it would have seeded: the
// reason, selectable, and the one thing to do about it.
export function LoadFailure({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <EmptyPanel>
      <p className="select-text">{message}</p>
      <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
        Retry
      </Button>
    </EmptyPanel>
  );
}
