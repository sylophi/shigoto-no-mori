// The icon button that opens a port on this machine in the browser,
// shared by the local row (the port itself) and the forward band (the
// local end of a live forward). Same failure toast as primitives/external-link.
import { ExternalLink } from "lucide-react";
import { Button } from "../../../primitives/button.tsx";
import { SimpleTooltip } from "../../../primitives/tooltip.tsx";
import { useOutside } from "../../../outside.tsx";

export function OpenLocalhostButtonView({
  port,
  disabledReason,
}: {
  port: number;
  // Why Open is unavailable. Disables the button and becomes its tip.
  disabledReason?: string;
}) {
  const { openUrl } = useOutside();
  const url = `http://localhost:${port}`;
  return (
    <SimpleTooltip tip={disabledReason}>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={`Open ${url}`}
        disabled={disabledReason !== undefined}
        className="text-muted-foreground hover:text-foreground"
        onClick={() => openUrl(url, "Couldn't open the port")}
      >
        <ExternalLink />
      </Button>
    </SimpleTooltip>
  );
}
