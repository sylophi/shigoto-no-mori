// The village toasts' parts, drawn (toasts.tsx sends them through
// sonner): the faces in a toast's icon slot with the badge on the front
// one, a moving-news title that ticks over, its detail line, and the
// lane's wrapper that sends news off at a click.
import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { VillagerFaceView } from "@shigomori/ui/views/shared/VillagerSaysView.tsx";
import type { Speaker } from "@shigomori/ui/lib/villagerVoice.ts";
import { cn } from "@shigomori/ui/lib/utils.ts";
import { MovingBoxView } from "./MovingBoxView";

// News goes at a click anywhere on it, or Enter on it focused, the way
// a villager's line goes at a press of A.
export function VillageToasterView({
  onDismiss,
  children,
}: {
  // The card under the event's target goes.
  onDismiss: (target: EventTarget) => void;
  children: ReactNode;
}) {
  return (
    <div
      role="presentation"
      className="contents"
      onClick={(event) => {
        // The rest of a double-click would go to the card sliding up
        // into this one's place.
        if (event.detail <= 1) onDismiss(event.target);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") onDismiss(event.target);
      }}
    >
      {children}
    </div>
  );
}

// The faces in the icon slot, overlapping like a group photo, the badge
// on the front one. One who joined news already showing (`joined`) pops
// in.
export function ToastFacesView({
  faces,
  badge,
  joined,
}: {
  faces: readonly (Speaker & { face: string })[];
  badge: ReactNode;
  joined: ReadonlySet<string>;
}) {
  return (
    <span className="flex">
      {faces.map((speaker, index) => (
        <span
          key={speaker.slug}
          className={cn(
            "flex rounded-full bg-popover",
            index > 0 && "-ml-3 ring-2 ring-popover",
            joined.has(speaker.slug) && "villager-join",
          )}
        >
          <VillagerFaceView
            face={speaker.face}
            className="size-8"
            badge={index === faces.length - 1 ? badge : undefined}
          />
        </span>
      ))}
    </span>
  );
}

export function MovingBoxBadgeView() {
  return <MovingBoxView className="absolute -right-1.5 -bottom-1 w-5" />;
}

export function SuccessBadgeView() {
  return (
    <span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full bg-emerald-500 text-popover">
      <Check aria-hidden className="size-3" strokeWidth={3.5} />
    </span>
  );
}

// A moving-news title that ticks over to name who joined it. Keyed by
// the title by its caller, so each change starts the tick over.
export function TickingTitleView({ children }: { children: ReactNode }) {
  return <span className="villager-tick block">{children}</span>;
}

// The news's note under its title, and the branch it is about.
export function MoveDetailView({
  detail,
  branch,
}: {
  detail: string;
  branch: string | null | undefined;
}) {
  return (
    <span className="block truncate">
      {detail}
      {branch && (
        <>
          {" "}
          <span className="font-mono">{branch}</span>
        </>
      )}
    </span>
  );
}
