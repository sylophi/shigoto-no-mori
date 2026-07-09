import { cn } from "@/lib/utils";
import { notifyError } from "@/lib/toast";

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
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        window.api.shell
          .openExternal(href)
          .catch((err) => notifyError(errorTitle, err));
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
