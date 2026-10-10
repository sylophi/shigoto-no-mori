import { cn } from "../../lib/utils.ts";

// The little arrow Animal Crossing bobs under a finished line, waiting
// on a press of A: here, the sign that village news goes at a click
// (VillageToaster). It fades in when `shown`, bobbing. Place and color
// it with `className`. A screen reader hears how to send the news away
// instead, since the card has no close button to find.
export function NextArrowView({
  shown = true,
  className,
}: {
  shown?: boolean;
  className?: string;
}) {
  return (
    <>
      <svg
        aria-hidden
        viewBox="0 0 12 9"
        className={cn(
          "h-2 w-3 shrink-0 transition-opacity duration-200",
          shown ? "villager-bob opacity-100" : "opacity-0",
          className,
        )}
      >
        <path
          d="M1.5 1.5h9q1.5 0 .7 1.3L7 7.6q-1 1.4-2 0L.8 2.8q-.8-1.3.7-1.3Z"
          fill="currentColor"
        />
      </svg>
      <span className="sr-only">Press Enter to dismiss.</span>
    </>
  );
}
