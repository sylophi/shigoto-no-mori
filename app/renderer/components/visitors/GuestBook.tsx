import { Heart } from "lucide-react";
import { VillagerFace } from "@/components/shared/VillagerSays";
import { StationeryPrint } from "@/components/villagers/StationeryPrint";
import { FaceStamp } from "@/components/villagers/VillagerLetter";
import {
  Nameplate,
  villagerInk,
} from "@/components/villagers/VillagerDialogue";
import { useFaceColor } from "@/hooks/villagers/useFaceColor";
import { useVillagerFace } from "@/hooks/villagers/useVillagers";
import { useNow } from "@/hooks/ui/useNow";
import { formatRelativeTime } from "@/lib/relativeTime";
import { cn } from "@/lib/utils";
import { villagerCatchphrase } from "@/lib/villagerVoice";
import { stationeryFor } from "@/lib/villagers/stationery";
import {
  type Album,
  type AlbumEntry,
  friendshipOf,
  visitDate,
  visitedTimes,
} from "@/lib/villagers/visitors";
import { AlbumProgress } from "./AlbumProgress";
import { Hearts } from "./Hearts";

// The Visitors section's front page, drawn as a ring-bound guest book
// lying open. The left page holds the best friend, on their own
// stationery with their face on a stamp. The right page shows how much
// of the album is filled, postmarked with the totals, and the newest
// face.
export function GuestBook({ album }: { album: Album }) {
  const { bestFriend, newest } = album;
  return (
    <section
      data-slot="visitor-guest-book"
      aria-label="Guest book"
      className="@container relative overflow-hidden rounded-[22px] bg-popover shadow-md"
    >
      <div className="grid @2xl:grid-cols-2">
        {bestFriend !== null && <BestFriend entry={bestFriend} />}
        <Collection album={album} newest={newest} />
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

function BestFriend({ entry }: { entry: AlbumEntry }) {
  const face = useVillagerFace(entry.slug);
  const color = useFaceColor(face);
  const paper = stationeryFor(entry.slug);
  const visits = entry.visits;
  if (visits === null) return null;
  const { hearts, title } = friendshipOf(visits.warmth);
  const catchphrase = villagerCatchphrase(entry.profile);
  return (
    <div
      style={villagerInk(color)}
      className="relative isolate flex min-h-56 overflow-hidden px-6 py-5"
    >
      <div
        aria-hidden
        className="absolute inset-0 -z-10 [mask-image:linear-gradient(to_left,black,transparent_85%)]"
      >
        <StationeryPrint paper={paper} className="opacity-25" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <PageEyebrow>
          <Heart aria-hidden className="size-3.5 fill-rose-400 text-rose-400" />
          Best friend
        </PageEyebrow>
        <div className="mt-4 flex items-center gap-5">
          {face !== null && (
            <FaceStamp
              face={face}
              tint={paper.color}
              className="visitor-stamp size-24 shrink-0 -rotate-3 bg-card p-1.5"
            />
          )}
          <div className="flex min-w-0 flex-col items-start gap-1.5">
            <Nameplate className="max-w-full truncate px-3 text-lg">
              {entry.profile.name}
            </Nameplate>
            <span className="text-sm font-medium">
              Visited {visitedTimes(visits.count)}
            </span>
            <span className="flex items-center gap-2">
              <Hearts filled={hearts} />
              <span className="text-xs font-medium text-rose-500">{title}</span>
            </span>
            <span className="text-xs text-muted-foreground">
              Since {visitDate(visits.first)}
            </span>
          </div>
        </div>
        {catchphrase !== null && (
          <span className="relative mt-4 self-start rounded-2xl bg-card px-3 py-1.5 text-sm font-medium shadow-sm">
            <span
              aria-hidden
              className="absolute -top-1.5 left-8 size-3 rotate-45 bg-card"
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
  newest,
}: {
  album: Album;
  newest: AlbumEntry | null;
}) {
  const met = album.visited.length;
  return (
    <div className="relative flex flex-col px-6 py-5 @2xl:pl-10">
      <PageEyebrow>Guest book</PageEyebrow>
      <div className="mt-3 flex items-baseline gap-2">
        <span className="text-4xl font-black tracking-tight tabular-nums">
          {met}
        </span>
        <span className="text-sm font-medium text-muted-foreground">
          of {album.total} villagers have visited
        </span>
      </div>
      <AlbumProgress
        met={met}
        total={album.total}
        label="Villagers met"
        className="mt-2 h-3"
      />
      <div className="mt-4 flex flex-wrap gap-3">
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
      {newest !== null && <NewestFace entry={newest} />}
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
      className={cn("visitor-postmark size-18 shrink-0", className)}
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
        y="39"
        textAnchor="middle"
        fontSize={value.length > 4 ? 13 : 17}
        fontWeight="900"
        fill="currentColor"
      >
        {value}
      </text>
      <text
        x="36"
        y="52"
        textAnchor="middle"
        fontSize="7.5"
        fontWeight="700"
        letterSpacing="0.6"
        fill="currentColor"
      >
        {label.toUpperCase()}
      </text>
    </svg>
  );
}

function NewestFace({ entry }: { entry: AlbumEntry }) {
  const face = useVillagerFace(entry.slug);
  const now = useNow();
  if (entry.visits === null) return null;
  return (
    <div className="mt-auto flex items-center gap-2.5 pt-4">
      <span className="text-xs font-medium text-muted-foreground">
        Newest face
      </span>
      <span className="flex min-w-0 items-center gap-2 rounded-full bg-muted py-1 pr-3 pl-1">
        {face !== null && <VillagerFace face={face} className="size-6" />}
        <span className="truncate text-sm font-bold">{entry.profile.name}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {formatRelativeTime(entry.visits.first, now)}
        </span>
      </span>
    </div>
  );
}
