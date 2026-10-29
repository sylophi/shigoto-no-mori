import { cn } from "../lib/utils.ts";

// How far something long has got: a bar filled to `ratio` (0 to 1), and
// what it is doing under it. `label` names it for a screen reader.
export function ProgressBar({
  ratio,
  caption,
  label,
  className,
}: {
  ratio: number;
  caption: string;
  label: string;
  className?: string;
}) {
  const percent = Math.round(ratio * 100);
  return (
    <div className={cn("flex flex-col items-center gap-1.5", className)}>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-sky-500 transition-[width] duration-300 ease-out motion-reduce:transition-none"
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="text-xs tabular-nums">{caption}</span>
    </div>
  );
}
