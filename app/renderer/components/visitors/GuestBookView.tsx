import { Heart } from "lucide-react";
import { VillagerFaceView } from "@shigomori/ui/views/shared/VillagerSaysView.tsx";
import { StationeryPrintView } from "@/components/villagers/StationeryPrintView";
import { FaceStampView } from "@/components/villagers/VillagerLetterView";
import {
  NameplateView,
  villagerInk,
} from "@/components/villagers/VillagerDialogueView";
import { useFaceColor } from "@/hooks/villagers/useFaceColor";
import { useNow } from "@shigomori/ui/hooks/useNow.ts";
import { formatRelativeTime } from "@shigomori/ui/lib/relativeTime.ts";
import { cn } from "@shigomori/ui/lib/utils.ts";
import { villagerCatchphrase } from "@shigomori/ui/lib/villagerVoice.ts";
import { stationeryFor } from "@/lib/villagers/stationery";
import {
  type Album,
  type VisitedEntry,
  visitDate,
  visitedTimes,
} from "@/lib/villagers/visitors";
import { AlbumProgressView } from "./AlbumProgressView";

// The Visitors section's front page, drawn as a ring-bound guest book
// lying open. The left page holds the best friend, on their own
// stationery with their face on a stamp. The right page shows how much
// of the album is filled, postmarked with the totals, and the newest
// face.
export function GuestBookView({
  album,
  bestFriendFace,
  newestFace,
}: {
  album: Album;
  // The best friend's face and the newest one's, once loaded.
  bestFriendFace: string | null;
  newestFace: string | null;
}) {
  const { bestFriend } = album;
  return (
    <section
      data-slot="visitor-guest-book"
      aria-label="Guest book"
      className="@container relative overflow-hidden rounded-[22px] bg-popover shadow-md"
    >
      <div className="grid @2xl:grid-cols-2">
        {bestFriend !== null && (
          <BestFriend entry={bestFriend} face={bestFriendFace} />
        )}
        <Collection album={album} newestFace={newestFace} />
      </div>
      <Binding />
    </section>
  );
}

// The rings down the spine, between the two pages.
function Binding() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-y-4 left-1/2 hidden -translate-x-1/2 flex-col justify-between @2xl:flex"
    >
      {Array.from({ length: 7 }, (_, i) => (
        <span
          key={i}
          className="h-2.5 w-5 rounded-full bg-muted-foreground/25"
        />
      ))}
    </div>
  );
}

function PageEyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
      {children}
    </span>
  );
}

function BestFriend({
  entry,
  face,
}: {
  entry: VisitedEntry;
  face: string | null;
}) {
  const color = useFaceColor(face);
  const paper = stationeryFor(entry.slug);
  const { visits } = entry;
  const catchphrase = villagerCatchphrase(entry.profile);
  return (
    <div
      style={villagerInk(color)}
      className="relative isolate flex overflow-hidden px-5 py-4"
    >
      <div
        aria-hidden
        className="absolute inset-0 -z-10 [mask-image:linear-gradient(to_left,black,transparent_85%)]"
      >
        <StationeryPrintView paper={paper} still className="opacity-25" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <PageEyebrow>
          <Heart aria-hidden className="size-3.5 fill-rose-400 text-rose-400" />
          Best friend
        </PageEyebrow>
        <div className="mt-3 flex items-center gap-4">
          {face !== null && (
            <FaceStampView
              face={face}
              tint={paper.color}
              className="visitor-stamp size-16 shrink-0 -rotate-3 bg-card"
            />
          )}
          <div className="flex min-w-0 flex-col items-start gap-1">
            <NameplateView className="max-w-full truncate px-2.5 text-base">
              {entry.profile.name}
            </NameplateView>
            <span className="text-xs font-medium">
              Visited {visitedTimes(visits.count)}
            </span>
            <span className="text-xs text-muted-foreground">
              Since {visitDate(visits.first)}
            </span>
          </div>
        </div>
        {catchphrase !== null && (
          <span className="relative mt-3 self-start rounded-xl bg-card px-2.5 py-1 text-xs font-medium shadow-sm">
            <span
              aria-hidden
              className="absolute -top-1 left-6 size-2 rotate-45 bg-card"
            />
            <span className="relative">“{catchphrase}”</span>
          </span>
        )}
      </div>
    </div>
  );
}

function Collection({
  album,
  newestFace,
}: {
  album: Album;
  newestFace: string | null;
}) {
  const { metTotal: met, newest } = album;
  return (
    <div className="relative flex flex-col px-5 py-4 @2xl:pl-9">
      <PageEyebrow>Guest book</PageEyebrow>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-2xl font-black tracking-tight tabular-nums">
          {met}
        </span>
        <span className="text-xs font-medium text-muted-foreground">
          of {album.total} villagers have visited
        </span>
      </div>
      <AlbumProgressView
        met={met}
        total={album.total}
        label="Villagers met"
        className="mt-2 h-2"
      />
      <div className="mt-3 flex flex-wrap gap-2">
        <Postmark
          label="Visits"
          value={String(album.visits)}
          className="-rotate-6 text-sky-600 dark:text-sky-400"
        />
        <Postmark
          label="Legends"
          value={`${album.met.legendary}/${album.sections.legendary.length}`}
          className="rotate-3 text-amber-600 dark:text-amber-400"
        />
        <Postmark
          label="Specials"
          value={`${album.met.rare}/${album.sections.rare.length}`}
          className="-rotate-2 text-violet-600 dark:text-violet-400"
        />
      </div>
      {newest !== null && <NewestFace entry={newest} face={newestFace} />}
    </div>
  );
}

// A total pressed on like a postmark: two rings, the figure inside and
// its name around the foot.
function Postmark({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <svg
      role="img"
      aria-label={`${label}: ${value}`}
      viewBox="0 0 72 72"
      className={cn("visitor-postmark size-14 shrink-0", className)}
    >
      <circle
        cx="36"
        cy="36"
        r="33"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
      />
      <circle
        cx="36"
        cy="36"
        r="27"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        strokeDasharray="2 2.5"
      />
      <text
        x="36"
        y="37"
        textAnchor="middle"
        fontSize={value.length > 4 ? 15 : 19}
        fontWeight="900"
        fill="currentColor"
      >
        {value}
      </text>
      <text
        x="36"
        y="50"
        textAnchor="middle"
        fontSize="8.5"
        fontWeight="700"
        fill="currentColor"
      >
        {label.toUpperCase()}
      </text>
    </svg>
  );
}

function NewestFace({
  entry,
  face,
}: {
  entry: VisitedEntry;
  face: string | null;
}) {
  const now = useNow();
  return (
    <div className="mt-auto flex items-center gap-2 pt-3">
      <span className="text-xs font-medium text-muted-foreground">
        Newest face
      </span>
      <span className="flex min-w-0 items-center gap-1.5 rounded-full bg-muted py-0.5 pr-2.5 pl-0.5">
        {face !== null && <VillagerFaceView face={face} className="size-5" />}
        <span className="truncate text-xs font-bold">{entry.profile.name}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {formatRelativeTime(entry.visits.first, now)}
        </span>
      </span>
    </div>
  );
}
