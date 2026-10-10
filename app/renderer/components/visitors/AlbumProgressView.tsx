import { cn } from "@shigomori/ui/lib/utils.ts";

// How much of the album (or a section of it) is filled: an emerald fill
// on a muted track, growing in from empty. Size the track with
// `className`. A first sticker always shows a sliver.
export function AlbumProgressView({
  met,
  total,
  label,
  className,
}: {
  met: number;
  total: number;
  label: string;
  className?: string;
}) {
  const share = total === 0 ? 0 : (met / total) * 100;
  return (
    <span
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={met}
      className={cn("block overflow-hidden rounded-full bg-muted", className)}
    >
      <span
        className="visitor-fill block h-full rounded-full bg-emerald-500"
        style={{ width: `${met > 0 ? Math.max(share, 2) : 0}%` }}
      />
    </span>
  );
}
