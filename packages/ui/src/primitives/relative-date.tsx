import { SimpleTooltip } from "./tooltip.tsx";
import { useNow } from "../hooks/useNow.ts";
import { formatRelativeTime } from "../lib/relativeTime.ts";

// "3d ago" with the full timestamp as the hover text, on a clock of its
// own, so the tick re-renders this alone. Takes a timestamp, or the
// string git prints (%aI), so commit rows and the last-commit strip
// agree.
export function RelativeDate({ date }: { date: string | number }) {
  const now = useNow();
  const value = new Date(date);
  return (
    <SimpleTooltip tip={value.toLocaleString()}>
      <span>{formatRelativeTime(value.getTime(), now)}</span>
    </SimpleTooltip>
  );
}
