// The icon button that opens a port on this machine in the browser,
// shared by the local row (the port itself) and the forward band (the
// local end of a live forward). Same failure toast as ui/external-link.
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { notifyError } from "@/lib/toast";

export function OpenLocalhostButton({
  port,
  disabled = false,
  disabledTip,
}: {
  port: number;
  disabled?: boolean;
  // Why Open is unavailable, shown in place of the address.
  disabledTip?: string;
}) {
  const url = `http://localhost:${port}`;
  return (
    // The span is the tooltip's trigger: a disabled button dispatches no
    // pointer events, and the disabled state is exactly the one whose
    // reason the tip carries.
    <SimpleTooltip tip={disabled && disabledTip ? disabledTip : `Open ${url}`}>
      <span className="inline-flex">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Open ${url}`}
          disabled={disabled}
          className="text-muted-foreground hover:text-foreground"
          onClick={() =>
            window.api.shell
              .openExternal(url)
              .catch((err) => notifyError("Couldn't open the port", err))
          }
        >
          <ExternalLink />
        </Button>
      </span>
    </SimpleTooltip>
  );
}
