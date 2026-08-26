// Catch-all for unknown paths: never a white screen, always a way back.
import { Button } from "@/components/ui/button";
import { CenteredMessage } from "@/components/ui/centered-message";
import { navigateTo, webPaths } from "./nav";

export function NotFoundPage() {
  return (
    <CenteredMessage>
      <div className="flex flex-col items-center gap-3">
        <span>There is nothing at this address.</span>
        <Button variant="outline" onClick={() => navigateTo(webPaths.devices)}>
          Go to devices
        </Button>
      </div>
    </CenteredMessage>
  );
}
