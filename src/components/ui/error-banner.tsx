import { cn } from "@/lib/utils";

interface ErrorBannerProps {
  children: React.ReactNode;
  className?: string;
}

export function ErrorBanner({ children, className }: ErrorBannerProps) {
  return (
    <div
      className={cn(
        "rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive",
        className,
      )}
    >
      {children}
    </div>
  );
}
