import { cn } from "@/lib/utils";

interface SectionHeadingProps {
  children: React.ReactNode;
  className?: string;
}

export function SectionHeading({ children, className }: SectionHeadingProps) {
  return (
    <h2
      className={cn(
        "text-xs font-semibold tracking-wide text-muted-foreground uppercase",
        className,
      )}
    >
      {children}
    </h2>
  );
}

// A settings-style section's heading with the paragraph that explains
// the section right under it. `action` sits at the right, centered on
// the heading and paragraph together, and wraps under them once the
// paragraph would be squeezed narrower than 16rem.
export function SectionIntro({
  title,
  action,
  children,
}: {
  title: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="min-w-0 flex-[1_1_16rem]">
        <SectionHeading className="mb-1">{title}</SectionHeading>
        <p className="text-xs text-muted-foreground">{children}</p>
      </div>
      {action && <div className="-mr-2 shrink-0">{action}</div>}
    </div>
  );
}
