import { useVillagerFace } from "@/hooks/villagers/useVillagers";
import type { Album } from "@shigomori/ui/lib/villagers/visitors.ts";
import { GuestBookView } from "@shigomori/ui/views/visitors/GuestBookView.tsx";

// The guest book (GuestBookView), with the two faces it shows.
export function GuestBook({ album }: { album: Album }) {
  return (
    <GuestBookView
      album={album}
      bestFriendFace={useVillagerFace(album.bestFriend?.slug ?? null)}
      newestFace={useVillagerFace(album.newest?.slug ?? null)}
    />
  );
}
