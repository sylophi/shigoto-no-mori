import { cn } from "@/lib/utils";

interface TidyStatProps {
  label: string;
  value: string;
  detail: string;
  // "positive" tints the headline when there is something worth acting
  // on. Everything else stays on theme tokens so the strip reads as
  // information, not as a SaaS metric card.
  tone?: "neutral" | "positive";
}

export function TidyStat({
  label,
  value,
  detail,
  tone = "neutral",
}: TidyStatProps) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-border bg-card px-3 py-2.5">
      <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </span>
      <span
        className={cn(
          "text-lg font-medium tabular-nums",
          tone === "positive" && "text-emerald-600 dark:text-emerald-400",
        )}
      >
        {value}
      </span>
      <span className="truncate text-xs text-muted-foreground" title={detail}>
        {detail}
      </span>
    </div>
  );
}
