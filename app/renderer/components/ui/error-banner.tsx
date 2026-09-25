import { InlineError } from "@/components/ui/inline-error";
import { cn } from "@/lib/utils";

// Copy written here goes in as children. An error's own text (git, gh,
// a hook) goes in as `message`, clamped with the rest behind Details,
// with `title` naming what failed for that dialog.
type ErrorBannerProps = { className?: string } & (
  | { children: React.ReactNode; message?: never; title?: never }
  | { message: string; title: string; children?: never }
);

export function ErrorBanner({
  children,
  message,
  title,
  className,
}: ErrorBannerProps) {
  return (
    <div
      className={cn(
        "rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive select-text",
        className,
      )}
    >
      {message === undefined ? (
        children
      ) : (
        <InlineError message={message} title={title} multiline />
      )}
    </div>
  );
}
