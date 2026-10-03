import { formatRelativeTime } from "@/lib/relativeTime";

// "3d ago" counted back from `now`, the view of RelativeDate
// (relative-date.tsx), which feeds it the shared clock. The hover text
// is the caller's: the full timestamp is the reader's locale, which a
// picture drawn at build time leaves out.
export function RelativeDateView({
  date,
  now,
  title,
}: {
  // The string git prints (%aI).
  date: string;
  now: number;
  title?: string;
}) {
  return (
    <span title={title}>
      {formatRelativeTime(new Date(date).getTime(), now)}
    </span>
  );
}
