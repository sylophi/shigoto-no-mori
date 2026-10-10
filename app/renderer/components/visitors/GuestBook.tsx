import { useVillagerFace } from "@/hooks/villagers/useVillagers";
import type { Album } from "@/lib/villagers/visitors";
import { GuestBookView } from "./GuestBookView";

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
