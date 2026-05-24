import { cn } from "@/lib/utils";

interface CenteredMessageProps {
  children: React.ReactNode;
  className?: string;
}

// Full-pane placeholder used by detail routes when their target is missing
// (project not found, worktree not found, script not found, etc.).
export function CenteredMessage({ children, className }: CenteredMessageProps) {
  return (
    <div
      className={cn(
        "flex h-full items-center justify-center text-sm text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}
