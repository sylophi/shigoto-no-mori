import { Check } from "lucide-react";
import type { ReactNode } from "react";
import {
  type ExternalToast,
  type ToastClassnames,
  Toaster,
  toast,
} from "sonner";
import {
  VillagerFaceView,
  VillagerSaysView,
} from "@/components/shared/VillagerSaysView";
import { cn } from "@/lib/utils";
import {
  MOVE_TOAST_MS,
  type MoveNews,
  type Speaker,
  villagerLine,
} from "@/lib/villagerVoice";
import { MovingBox } from "./MovingBox";
import { NextArrow } from "./NextArrow";
import { VillagerDialogue } from "./VillagerDialogue";
import { VillagerLetter } from "./VillagerLetter";

// The toasts villagers speak in (DESIGN.md, "Village life: rarity").

const VILLAGE_TOASTER = "village";

// The toaster village news goes to (toastVillagerMove), mounted beside
// the everyday one (AppChrome.tsx) with its look. A lane of its own in
// the top corner, so a villager moving in never covers the toasts that
// matter: an error, or an undo waiting on its button. It sits below the
// title-bar drag strip (AppShell.tsx), which would swallow clicks on
// its top edge, and answers Alt+Shift+T, leaving Alt+T to the everyday
// toasts.
//
// News goes at a click anywhere on it, or Enter on it focused, the way
// a villager's line goes at a press of A, so it wears no close button,
// only the arrow a finished line waits on (NextArrow). Its words can't
// be selected, unlike the everyday toasts', so a click meant to send it
// off never lands in a selection instead. Each news toast carries its
// id as its test id, since sonner puts no other on the card.
export function VillageToaster({
  classNames,
}: {
  classNames: ToastClassnames;
}) {
  return (
    <div
      role="presentation"
      className="contents"
      onClick={(event) => {
        // The rest of a double-click would go to the card sliding up
        // into this one's place.
        if (event.detail <= 1) dismissCard(event.target);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") dismissCard(event.target);
      }}
    >
      <Toaster
        id={VILLAGE_TOASTER}
        containerAriaLabel="Village news"
        hotkey={["altKey", "shiftKey", "KeyT"]}
        position="top-right"
        offset={{ top: 40, right: 16 }}
        toastOptions={{
          className: "cursor-pointer",
          classNames: {
            ...classNames,
            title: cn(classNames.title, "!select-none"),
            description: cn(classNames.description, "!select-none"),
          },
        }}
      />
    </div>
  );
}

function dismissCard(target: EventTarget): void {
  if (!(target instanceof Element)) return;
  const card = target.closest("[data-sonner-toast]");
  const id = card?.getAttribute("data-testid");
  if (id) toast.dismiss(id);
}

// A success about one worktree, which its villager says when it has one
// (lib/villagerVoice.ts): their catchphrase ends the title, and their
// face takes the check's place, wearing the check as a badge so the
// toast still reads as a success. Without a speaker it is a plain
// success. Callers go through useWorktreeSuccessToast, which finds the
// speaker. Failures never come through here.
export function toastVillagerSuccess(
  speaker: Speaker | undefined,
  message: string,
  options?: ExternalToast,
): void {
  if (speaker === undefined) {
    toast.success(message, options);
    return;
  }
  const line = villagerLine(speaker, message);
  const faces = faceOptions([speaker]);
  toast.success(line === null ? message : <VillagerSaysView line={line} />, {
    ...options,
    ...faces,
    classNames: { ...options?.classNames, ...faces.classNames },
  });
}

// Villagers moving in or out (lib/villagers/moves.ts), one toast for
// everyone who moved at once. The rarer the one moving, the more of
// Animal Crossing comes with it (DESIGN.md, "Village life: rarity"): a
// rare character speaks in a dialogue box, and a legendary one writes a
// letter. Everyone else, and several at once, get a toast with their
// faces. All of it goes to the village lane (VillageToaster). An id
// still showing is replaced in place, its time starting over, and
// `onClose` hears when it goes, timed out or sent away. The villagers
// who `joined` it (by slug) pop into the faces, and the title ticks
// over to name them.
export function toastVillagerMove(
  news: MoveNews,
  id: string,
  { joined, onClose }: { joined?: ReadonlySet<string>; onClose: () => void },
): void {
  const lane = {
    id,
    toasterId: VILLAGE_TOASTER,
    testId: id,
    // sonner starts a toast's time over only when its duration changes,
    // a hover having paused it or not, so news that grows lasts a
    // millisecond longer for each worktree in it.
    duration: MOVE_TOAST_MS[news.rarity] + news.worktreeIds.length,
    onDismiss: onClose,
    onAutoClose: onClose,
  };
  const [speaker] = news.speakers;
  if (news.words !== null) {
    const words = news.words;
    const Moment =
      speaker.rarity === "legendary" ? VillagerLetter : VillagerDialogue;
    toast.custom(
      () => <Moment news={news} speaker={speaker} words={words} />,
      lane,
    );
    return;
  }
  const title =
    news.line === null ? news.title : <VillagerSaysView line={news.line} />;
  toast.success(
    !joined?.size ? (
      title
    ) : (
      // Keyed by the title, so each change starts the tick over.
      <span key={news.title} className="villager-tick block">
        {title}
      </span>
    ),
    {
      ...lane,
      // Moving out, the front face wears a moving box, not the check.
      ...faceOptions(
        news.speakers,
        news.kind === "out" ? <MovingBoxBadge /> : <SuccessBadge />,
        joined,
      ),
      // sonner draws an element given as the action as it is, at the
      // end of the row.
      action: (
        <NextArrow className="mb-0.5 ml-auto self-end text-muted-foreground" />
      ),
      description: news.detail && (
        <span className="block truncate">
          {news.detail}
          {news.branch && (
            <>
              {" "}
              <span className="font-mono">{news.branch}</span>
            </>
          )}
        </span>
      ),
    },
  );
}

// The faces in the icon slot, overlapping like a group photo, the check
// on the front one. Only speakers with a face are in it, the last three,
// so one who joins news already showing (`joined`) pops in at the
// front. With none, the toast keeps its plain check.
function faceOptions(
  speakers: readonly Speaker[],
  badge: ReactNode = <SuccessBadge />,
  joined: ReadonlySet<string> = new Set(),
): ExternalToast {
  const faces = speakers
    .filter((speaker): speaker is Speaker & { face: string } =>
      Boolean(speaker.face),
    )
    .slice(-3);
  if (faces.length === 0) return {};
  return {
    icon: (
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
    ),
    // sonner's icon box is 16px square. The faces need room, and a note
    // under the title keeps them at its top.
    classNames: { icon: "!h-8 !w-auto !self-start" },
  };
}

function MovingBoxBadge() {
  return <MovingBox className="absolute -right-1.5 -bottom-1 w-5" />;
}

function SuccessBadge() {
  return (
    <span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full bg-emerald-500 text-popover">
      <Check aria-hidden className="size-3" strokeWidth={3.5} />
    </span>
  );
}
