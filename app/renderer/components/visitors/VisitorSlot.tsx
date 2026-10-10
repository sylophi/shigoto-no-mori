import { useSeen } from "@/hooks/ui/useSeen";
import { useVillagerFace } from "@/hooks/villagers/useVillagers";
import type { AlbumEntry } from "@shigomori/ui/lib/villagers/visitors.ts";
import { VisitorSlotView } from "@shigomori/ui/views/visitors/VisitorStickerView.tsx";

// One slot of the album (VisitorSlotView), its face loaded once the
// slot is scrolled near.
export function VisitorSlot({
  entry,
  index,
  bestFriend,
}: {
  entry: AlbumEntry;
  index: number;
  bestFriend: boolean;
}) {
  const [ref, seen] = useSeen<HTMLDivElement>();
  const face = useVillagerFace(seen ? entry.slug : null);
  return (
    <VisitorSlotView
      entry={entry}
      index={index}
      bestFriend={bestFriend}
      face={face}
      slotRef={ref}
    />
  );
}
