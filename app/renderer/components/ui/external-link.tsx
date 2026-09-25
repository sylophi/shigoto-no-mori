import { cn } from "@/lib/utils";
import { openExternalUrl } from "@/lib/openExternal";

// Inline text button that opens a web URL in the system browser via the
// scheme-validated shell IPC (renderer windows never navigate).
export function ExternalLink({
  href,
  errorTitle = "Couldn't open link",
  className,
  children,
}: {
  href: string;
  errorTitle?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      // Sits in running text: the phone's 44px hit area (phone.css)
      // would cover the lines above and below it.
      data-no-hit-area
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openExternalUrl(href, errorTitle);
      }}
      className={cn(
        "underline underline-offset-2 hover:text-foreground",
        className,
      )}
    >
      {children ?? "Learn more"}
    </button>
  );
}
