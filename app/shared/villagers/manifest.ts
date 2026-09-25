// The villager manifest (manifest.json beside this file, written by
// scripts/fetch-doubutsu-names.mts): for every villager in the
// doubutsu name pool, where its profile and face live on Nookipedia.
// References only. The app downloads what they point at when its user
// asks (host/lib/villagers.ts) and checks each face against its size
// and sha1 here.
import manifestJson from "./manifest.json";

export interface VillagerFaceRef {
  // The wiki's file title, e.g. "File:Ace NH Villager Icon.png".
  file: string;
  // The file's own page on the wiki, where its credits live.
  filePage: string;
  // The image itself, and what it must be.
  image: string;
  bytes: number;
  sha1: string;
}

export interface VillagerManifest {
  source: { name: string; url: string; retrieved: string };
  // Slug → the villager's wiki page title and face.
  villagers: Record<string, { page: string; icon: VillagerFaceRef }>;
  // Characters without a face on the wiki, left out of the name pool.
  missing: string[];
}

export const villagerManifest: VillagerManifest = manifestJson;
