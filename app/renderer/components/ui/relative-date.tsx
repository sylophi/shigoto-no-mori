import { useNow } from "@/hooks/ui/useNow";
import { RelativeDateView } from "./relative-date-view";

// "3d ago" with the full timestamp as the hover text. Takes the string
// git prints (%aI), so commit rows and the last-commit strip agree.
export function RelativeDate({ date }: { date: string }) {
  const now = useNow();
  return (
    <RelativeDateView
      date={date}
      now={now}
      title={new Date(date).toLocaleString()}
    />
  );
}
