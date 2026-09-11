import { formatRelativeTime } from "@/lib/relativeTime";

// "3d ago" with the full timestamp as the hover text. Takes the string
// git prints (%aI), so commit rows and the last-commit strip agree.
export function RelativeDate({ date }: { date: string }) {
  const value = new Date(date);
  return (
    <span title={value.toLocaleString()}>
      {formatRelativeTime(value.getTime())}
    </span>
  );
}
