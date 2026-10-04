// The villager data in the fake host: the villagers:* channels
// (host/lib/villagers.ts), served from lab/fake-host/villager-data, a real
// download made with the app's own downloader by `pnpm villagers:fetch`
// (scripts/fetch-villager-data.mts). That folder is gitignored and
// never committed. Without it the data reads as not downloaded, and a
// posed download ends with no faces to show.
//
// ?villagers=absent|downloading|ready|failed poses the status (default:
// ready with the folder, absent without). Download, cancel and remove
// play out on it. ?visits=none empties the Visitors album (below).
import type { VillagerDataStatus, VillagerProfiles } from "@shared/schemas";
import { villagerManifest } from "@shared/villagers/manifest";
import type { AllChannelHandlers } from "@shared/ipc/client";

const faces = import.meta.glob<string>("./villager-data/ready/faces/*.png", {
  query: "?inline",
  import: "default",
});
const [meta] = Object.values(
  import.meta.glob<{ downloadedAt: string }>(
    "./villager-data/ready/meta.json",
    { eager: true, import: "default" },
  ),
);
const [loadProfiles] = Object.values(
  import.meta.glob<VillagerProfiles>("./villager-data/ready/profiles.json", {
    import: "default",
  }),
);

const villagers = Object.keys(villagerManifest.villagers).length;

// Whether this checkout holds a fake host download.
export const fakeHasVillagerData = meta !== undefined;

const ABSENT: VillagerDataStatus = { kind: "absent", villagers };
const READY: Extract<VillagerDataStatus, { kind: "ready" }> = {
  kind: "ready",
  downloadedAt: meta?.downloadedAt ?? new Date().toISOString(),
  villagers,
};
// Frozen partway, for a still shot.
const POSES: Record<string, VillagerDataStatus> = {
  absent: ABSENT,
  ready: READY,
  downloading: { kind: "downloading", done: 212, villagers },
  failed: {
    kind: "failed",
    done: 212,
    villagers,
    message: "Couldn't reach Nookipedia.",
  },
};

function posedStatus(): VillagerDataStatus {
  const posed = new URLSearchParams(location.search).get("villagers");
  return (
    (posed === null ? undefined : POSES[posed]) ??
    (fakeHasVillagerData ? READY : ABSENT)
  );
}

// One device's villager data channels, each device with its own status.
export function villagerHandlersFor(): AllChannelHandlers {
  let status = posedStatus();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    clearInterval(timer);
    timer = undefined;
  };
  const clear = () => {
    stop();
    status = ABSENT;
    return status;
  };
  const shown = () => status.kind === "ready" && fakeHasVillagerData;
  return {
    "villagers:status": () => status,
    // A download that takes a few seconds, from wherever it stopped.
    "villagers:download": () => {
      if (status.kind === "ready" || timer !== undefined) return status;
      let done = status.kind === "failed" ? status.done : 0;
      status = { kind: "downloading", done, villagers };
      timer = setInterval(() => {
        done = Math.min(villagers, done + 23);
        status = { kind: "downloading", done, villagers };
        if (done === villagers) {
          stop();
          status = { ...READY, downloadedAt: new Date().toISOString() };
        }
      }, 150);
      return status;
    },
    "villagers:cancel": clear,
    "villagers:remove": clear,
    "villagers:face": async ({ slug }) => {
      const load = faces[`./villager-data/ready/faces/${slug}.png`];
      if (!shown() || load === undefined) return null;
      return (await load()).replace(/^data:image\/png;base64,/, "");
    },
    "villagers:profiles": async () =>
      shown() && loadProfiles !== undefined ? loadProfiles() : null,
  };
}

// The Visitors album's log (renderer/lib/villagers/visitLog.ts), kept
// in localStorage, posed fresh on every load, before the renderer reads
// it: a spread of visits, or none with
// ?visits=none. Slug, times, and the days ago of the first and last.
const DAY = 24 * 60 * 60_000;
const FAKE_VISITS: [string, number, number, number][] = [
  ["raymond", 17, 200, 1],
  ["marshal", 6, 150, 9],
  ["judy", 4, 120, 30],
  ["sherb", 3, 90, 12],
  ["stitches", 3, 140, 22],
  ["sheldon", 5, 170, 3],
  ["ankha", 2, 80, 40],
  ["zucker", 2, 75, 5],
  ["dom", 2, 90, 30],
  ["fauna", 2, 64, 21],
  ["bob", 1, 2, 2],
  ["audie", 1, 60, 60],
  ["lolly", 1, 4, 4],
  ["maple", 1, 200, 200],
  ["ketchup", 1, 11, 11],
  ["molly", 1, 25, 25],
  ["ace", 1, 1, 1],
  ["tom-nook", 2, 180, 20],
  ["isabelle", 3, 160, 7],
  ["kk-slider", 1, 3, 3],
  ["celeste", 1, 50, 50],
  ["pascal", 1, 6, 6],
  ["katrina", 1, 45, 45],
  ["leif", 2, 100, 14],
  ["daisy-mae", 2, 70, 16],
];

function poseFakeVisits(): void {
  const none = new URLSearchParams(location.search).get("visits") === "none";
  const now = Date.now();
  const log: Record<string, { slug: string; at: number }> = {};
  if (!none) {
    for (const [slug, count, first, last] of FAKE_VISITS) {
      const step = count > 1 ? (first - last) / (count - 1) : 0;
      for (let i = 0; i < count; i++) {
        const at = now - (last + i * step) * DAY;
        log[`fake-host:${slug}-${i}:${at}`] = { slug, at };
      }
    }
  }
  localStorage.setItem("villagers.visits", JSON.stringify(log));
}
poseFakeVisits();
