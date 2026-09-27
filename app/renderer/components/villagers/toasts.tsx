import { Check } from "lucide-react";
import type { ReactNode } from "react";
import {
  type ExternalToast,
  type ToastClassnames,
  Toaster,
  toast,
} from "sonner";
import { VillagerFace, VillagerSays } from "@/components/shared/VillagerSays";
import { cn } from "@/lib/utils";
import {
  MOVE_TOAST_MS,
  type MoveNews,
  type Speaker,
  villagerLine,
} from "@/lib/villagerVoice";
import { MovingBox } from "./MovingBox";
import { VillagerDialogue } from "./VillagerDialogue";
import { VillagerLetter } from "./VillagerLetter";

// The toasts villagers speak in (DESIGN.md, "Village life: rarity").

const VILLAGE_TOASTER = "village";

// The toaster village news goes to (toastVillagerMove), mounted beside
// the everyday one (AppChrome.tsx) with its look. A lane of its own in
// the top corner, so a villager moving in never covers the toasts that
// matter: an error, or an undo waiting on its button. It sits below the
// title-bar drag strip (AppShell.tsx), which would swallow clicks on
// its top edge and close buttons, and answers Alt+Shift+T, leaving
// Alt+T to the everyday toasts.
//
// News goes at a click anywhere on it, or Enter on it focused, the way
// a villager's line goes at a press of A, unless that hit one of its
// buttons or ended a drag that selected some of its words. It goes on
// the first click, so its words are selected by dragging, not by
// double-clicking. Each news toast carries its id as its test id, since
// sonner puts no other on the card.
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
        closeButton
        toastOptions={{ className: "cursor-pointer", classNames }}
      />
    </div>
  );
}

function dismissCard(target: EventTarget): void {
  if (!(target instanceof Element) || target.closest("button, a")) return;
  const card = target.closest("[data-sonner-toast]");
  const id = card?.getAttribute("data-testid");
  if (!card || !id) return;
  // A click inside selected words clears them only once it's done, so
  // the selection is read a task later. A drag's selection is still up.
  setTimeout(() => {
    const selection = window.getSelection();
    if (
      selection?.isCollapsed === false &&
      card.contains(selection.anchorNode)
    ) {
      return;
    }
    toast.dismiss(id);
  });
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
  toast.success(line === null ? message : <VillagerSays line={line} />, {
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
// faces. All of it goes to the village lane (VillageToaster).
export function toastVillagerMove(news: MoveNews, id: string): void {
  const lane = {
    id,
    toasterId: VILLAGE_TOASTER,
    testId: id,
    duration: MOVE_TOAST_MS[news.rarity],
  };
  const [speaker] = news.speakers;
  if (news.words !== null) {
    const words = news.words;
    const Moment =
      speaker.rarity === "legendary" ? VillagerLetter : VillagerDialogue;
    toast.custom(
      (toastId) => (
        <Moment
          news={news}
          speaker={speaker}
          words={words}
          onClose={() => toast.dismiss(toastId)}
        />
      ),
      lane,
    );
    return;
  }
  toast.success(
    news.line === null ? news.title : <VillagerSays line={news.line} />,
    {
      ...lane,
      // Moving out, the front face wears a moving box, not the check.
      ...faceOptions(
        news.speakers,
        news.kind === "out" ? <MovingBoxBadge /> : <SuccessBadge />,
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
// on the front one. Only speakers with a face are in it. With none, the
// toast keeps its plain check.
function faceOptions(
  speakers: readonly Speaker[],
  badge: ReactNode = <SuccessBadge />,
): ExternalToast {
  const faces = speakers
    .filter((speaker): speaker is Speaker & { face: string } =>
      Boolean(speaker.face),
    )
    .slice(0, 3);
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
            )}
          >
            <VillagerFace
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
