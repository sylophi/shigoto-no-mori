import type { ReactNode } from "react";
import { PAGE_BODY } from "../shared/PageShellView.tsx";
import { LoadFailure } from "../../primitives/load-failure.tsx";

// The "All devices" tab's sections, the project's shared settings.
export function ConfigureSharedView({ children }: { children: ReactNode }) {
  return (
    <div className={PAGE_BODY}>
      <div className="flex flex-col gap-10">{children}</div>
    </div>
  );
}

// A device's project file that would not load.
export function ConfigureLoadFailureView({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="p-6 phone:p-4">
      <LoadFailure message={message} onRetry={onRetry} />
    </div>
  );
}
