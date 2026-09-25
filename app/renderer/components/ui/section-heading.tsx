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
// the section right under it.
export function SectionIntro({
  title,
  children,
}: {
  title: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <SectionHeading className="mb-1">{title}</SectionHeading>
      <p className="text-xs text-muted-foreground">{children}</p>
    </div>
  );
}
